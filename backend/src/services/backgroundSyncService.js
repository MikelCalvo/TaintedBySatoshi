require("dotenv").config();
const dbService = require("./dbService");
const bitcoinRPC = require("./bitcoinRPC");
const logger = require("../utils/logger");
const path = require("path");
const fs = require("fs");
const { normalizeTaintedDegree } = require("./syncUtils");

// Load Satoshi addresses
let SATOSHI_ADDRESSES = [];
let SATOSHI_ADDRESS_SET = new Set();
function loadSatoshiAddresses() {
  try {
    const satoshiData = require("../../data/satoshiAddresses");
    SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
    SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
    return SATOSHI_ADDRESSES.length > 0;
  } catch (err) {
    return false;
  }
}

class BackgroundSyncService {
  constructor(dependencies = {}) {
    this.bitcoinRPC = dependencies.bitcoinRPC || bitcoinRPC;
    this.dbService = dependencies.dbService || dbService;
    this.logger = dependencies.logger || logger;
    this.ensureInitializedOverride = dependencies.ensureInitialized || null;
    this.startSyncLoopOverride = dependencies.startSyncLoop || null;
    if (dependencies.satoshiAddresses) {
      SATOSHI_ADDRESSES = dependencies.satoshiAddresses;
      SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
    }
    this.isRunning = false;
    this.isSyncing = false;
    this.syncInterval = null;
    this.lastProcessedBlock = null;
    this.currentHeight = null;
    this.syncStats = {
      lastSyncTime: null,
      blocksProcessed: 0,
      addressesUpdated: 0,
      errors: 0,
    };

    // Configuration from environment
    this.config = {
      syncInterval: parseInt(process.env.SYNC_INTERVAL) || 10 * 60 * 1000, // 10 minutes default
      enabled: process.env.SYNC_ENABLED !== "false", // default true
      batchSize: parseInt(process.env.BATCH_SIZE) || 1000,
      batchFlushInterval: parseInt(process.env.BATCH_FLUSH_INTERVAL) || 5000,
      chunkSize: parseInt(process.env.CHUNK_SIZE) || 100, // Process 100 blocks per chunk
    };

    // Batch management
    this.mainBatch = null;
    this.batchCount = 0;
    this.lastBatchFlush = Date.now();
    this.parentTaintingCache = new Map();
    this.batchIsValid = false;
    this.mainDb = null;

    // Database ready flag
    this.dbReady = false;
    this.starting = null;
  }

  async start() {
    if (this.starting) {
      return this.starting;
    }
    if (this.isRunning) {
      this.logger.info("Background sync service is already running");
      return;
    }

    if (!this.config.enabled) {
      this.logger.info("Background sync is disabled (SYNC_ENABLED=false)");
      return;
    }

    this.starting = (async () => {
      this.isRunning = true;
      this.logger.info("Background sync service initializing...");

      try {
        await this.bitcoinRPC.initialize();
        const initialize = this.ensureInitializedOverride
          ? this.ensureInitializedOverride
          : () => this.ensureInitialized();
        await initialize();
        this.dbReady = true;
      } catch (error) {
        this.logger.error("Failed to initialize background sync:", error.message);
        this.isRunning = false;
        this.dbReady = false;
        throw error;
      }

      this.logger.info("Background sync service started");
      if (this.startSyncLoopOverride) {
        this.startSyncLoopOverride();
      } else {
        this.startSyncLoop();
      }
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async initializeCoinbaseOutputs() {
    // Use shared database instance to avoid locking conflicts
    const scanDb = await this.bitcoinRPC.openDatabase();

    try {
      logger.info("🔍 Initializing Satoshi coinbase outputs as tainted...");
      logger.info(`Using ${SATOSHI_ADDRESSES.length.toLocaleString()} Patoshi addresses`);
      logger.info(`📚 Source: https://github.com/bensig/patoshi-addresses`);
      logger.info(`   Patoshi Pattern Analysis by Sergio Demian Lerner`);
      logger.info(`   https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/`);
      logger.info("\nScanning Patoshi blocks to extract coinbase outputs...");

      const { PATOSHI_BLOCKS } = require("../../data/patoshiBlocks");
      const coinbaseBatch = scanDb.batch();
      let initCount = 0;

      // Add genesis and early blocks
      const EARLY_BLOCKS = [0, 1, 2];
      const allBlocks = [...EARLY_BLOCKS, ...PATOSHI_BLOCKS];

      for (let i = 0; i < allBlocks.length; i++) {
        const height = allBlocks[i];

        if (i % 1000 === 0) {
          logger.info(
            `  Progress: ${i}/${allBlocks.length} (${((i / allBlocks.length) * 100).toFixed(1)}%)`
          );
        }

        try {
          const hash = await this.bitcoinRPC.call("getblockhash", [height]);
          const block = await this.bitcoinRPC.call("getblock", [hash, 2]);
          const coinbaseTx = block.tx[0];

          // Mark each coinbase output as tainted
          for (let voutIndex = 0; voutIndex < coinbaseTx.vout.length; voutIndex++) {
            const vout = coinbaseTx.vout[voutIndex];
            const address = this.bitcoinRPC.getAddressFromScript(vout.scriptPubKey);
            const outpoint = `${coinbaseTx.txid}:${voutIndex}`;

            coinbaseBatch.put(`tainted_out:${outpoint}`, {
              address: address || null,
              degree: 0,
              txHash: coinbaseTx.txid,
              blockHeight: height,
            });
            initCount++;
          }
        } catch (error) {
          logger.error(`Error processing block ${height}:`, error.message);
        }
      }

      await coinbaseBatch.write();
      await scanDb.put("satoshi_coinbase_initialized", {
        initialized: true,
        timestamp: Date.now(),
        count: initCount,
      });

      logger.info(`✓ Initialized ${initCount} Satoshi coinbase outputs as tainted\n`);
    } catch (error) {
      logger.error("Failed to initialize coinbase outputs:", error.message);
      throw error;
    }
    // Don't close scanDb - it's a shared instance managed by bitcoinRPC
  }

  startSyncLoop() {
    const syncLoop = async () => {
      if (!this.isRunning) {
        return; // Stop loop if service is stopped
      }

      try {
        await this.checkAndSync();
      } catch (err) {
        logger.error("Error in sync loop:", err.message);
        this.syncStats.errors++;
      }

      // Adaptive interval: faster when catching up, slower when synced
      let nextInterval;
      if (this.currentHeight && this.lastProcessedBlock !== null) {
        const blocksBehind = this.currentHeight - this.lastProcessedBlock;

        if (blocksBehind > 1000) {
          // Very behind: sync every 5 seconds
          nextInterval = 5000;
        } else if (blocksBehind > 100) {
          // Behind: sync every 30 seconds
          nextInterval = 30000;
        } else if (blocksBehind > 0) {
          // Almost caught up: sync every 2 minutes
          nextInterval = 2 * 60 * 1000;
        } else {
          // Fully synced: check every 10 minutes (or configured interval)
          nextInterval = this.config.syncInterval;
        }
      } else {
        // Initial state: check every 30 seconds
        nextInterval = 30000;
      }

      // Schedule next sync
      this.syncInterval = setTimeout(syncLoop, nextInterval);
    };

    // Start the loop
    syncLoop();
  }

  async ensureInitialized() {
    try {
      logger.info("[Init] Step 1: Checking data directory...");
      const satoshiAddressesPath = path.join(__dirname, "../../data/satoshiAddresses.js");
      const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data");

      // Ensure data directory exists
      if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
      }

      // Step 1: Extract Patoshi addresses before scanning if needed
      if (!fs.existsSync(satoshiAddressesPath)) {
        logger.info("[Init] Patoshi addresses not found, extracting before sync...");
        const { extractPatoshiAddresses } = require("../scripts/extractPatoshiAddresses");
        await extractPatoshiAddresses();
      }

      logger.info("[Init] Step 2: Loading Satoshi addresses...");
      // Load addresses
      if (!loadSatoshiAddresses()) {
        throw new Error("Failed to load Satoshi addresses");
      }

      if (SATOSHI_ADDRESSES.length === 0) {
        throw new Error("No Satoshi addresses found in satoshiAddresses.js");
      }
      logger.info(`[Init] Loaded ${SATOSHI_ADDRESSES.length.toLocaleString()} Satoshi addresses`);

      logger.info("[Init] Step 3: Initializing main database...");
      // Step 2: Initialize main database and Satoshi addresses
      const db = await this.dbService.init();
      this.dbReady = true;
      logger.info("[Init] Main database ready");

      logger.info("[Init] Step 4: Checking Satoshi address seeds...");
      let needsAddressInit = false;
      try {
        await db.get(`tainted:${SATOSHI_ADDRESSES[0]}`);
        logger.info("[Init] Satoshi addresses already initialized");
      } catch (err) {
        if (err.code !== "LEVEL_NOT_FOUND") throw err;
        needsAddressInit = true;
      }

      if (needsAddressInit) {
        logger.info("[Init] Initializing Satoshi addresses...");
        const taintedBatch = db.batch();
        for (const address of SATOSHI_ADDRESSES) {
          taintedBatch.put(`tainted:${address}`, {
            txHash: null,
            originalSatoshiAddress: address,
            amount: 0,
            degree: 0,
            path: [],
            lastUpdated: Date.now(),
          });
        }
        await taintedBatch.write();
        logger.info(`✓ Initialized ${SATOSHI_ADDRESSES.length.toLocaleString()} Satoshi addresses`);
      }

      logger.info("[Init] Step 5: Checking coinbase seeds...");
      const scanDb = await this.bitcoinRPC.openDatabase();
      let coinbaseReady = false;
      try {
        await scanDb.get("satoshi_coinbase_initialized");
        coinbaseReady = true;
        logger.info("[Init] Coinbase outputs already initialized");
      } catch (err) {
        if (err.code !== "LEVEL_NOT_FOUND") throw err;
      }

      if (!coinbaseReady) {
        logger.info("[Init] Initializing Satoshi coinbase outputs before sync...");
        await this.initializeCoinbaseOutputs();
      }

      logger.info("[Init] Initialization checks completed");
    } catch (error) {
      logger.error("[Init] Error during initialization:", error.message);
      logger.error(error.stack);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.syncInterval) {
      clearTimeout(this.syncInterval);
      this.syncInterval = null;
    }

    // Flush any pending batch
    await this.flushBatch();
    this.batchIsValid = false;
    this.mainDb = null;
    this.dbReady = false;

    logger.info("Background sync service stopped");
  }

  async checkAndSync() {
    if (this.isSyncing) {
      return; // Already syncing, skip this check
    }

    // Wait for database to be ready
    if (!this.dbReady) {
      logger.info("[Background Sync] Waiting for database initialization...");
      return;
    }

    try {
      this.isSyncing = true;

      // Get current blockchain height
      const blockchainInfo = await this.bitcoinRPC.getBlockchainInfo();
      this.currentHeight = blockchainInfo.blocks;

      // Get last processed block from scan_progress DB
      const scanDb = await this.bitcoinRPC.openDatabase();
      let lastProcessedBlock = -1;

      try {
        const progress = await scanDb.get("scan_progress");
        lastProcessedBlock = progress.lastBlock ?? -1;
      } catch (err) {
        // No progress saved, start from beginning
        lastProcessedBlock = -1;
      }

      this.lastProcessedBlock = lastProcessedBlock;

      // Check if there are blocks to process
      if (this.currentHeight > lastProcessedBlock) {
        const blocksToProcess = this.currentHeight - lastProcessedBlock;
        const startBlock = lastProcessedBlock + 1;

        // Process in chunks to avoid blocking for too long
        const endBlock = Math.min(startBlock + this.config.chunkSize - 1, this.currentHeight);
        const remainingBlocks = this.currentHeight - lastProcessedBlock;

        logger.info(`[Background Sync] Processing chunk: blocks ${startBlock}-${endBlock} (${remainingBlocks.toLocaleString()} remaining)`);

        await this.syncNewBlocks(startBlock, endBlock, scanDb);
      } else {
        // No new blocks, just update stats
        this.syncStats.lastSyncTime = new Date().toISOString();
      }
    } catch (error) {
      logger.error("[Background Sync] Error during sync check:", error.message);
      this.syncStats.errors++;
    } finally {
      this.isSyncing = false;
    }
  }

  async syncNewBlocks(startBlock, endBlock, scanDb) {
    const db = await this.dbService.init();
    this.mainDb = db;
    let processedBlocks = 0;

    // Initialize batch for main DB
    this.resetBatch();

    try {
      for (let height = startBlock; height <= endBlock; height++) {
        try {
          // Get block hash
          const hash = await this.bitcoinRPC.call("getblockhash", [height]);

          // Get full block data
          const block = await this.bitcoinRPC.call("getblock", [hash, 2]);

          // Process the block
          await this.processBlock(block, db, scanDb);

          processedBlocks++;
          this.syncStats.blocksProcessed++;

          // Flush batch periodically or when it reaches size limit
          if (this.batchCount >= this.config.batchSize ||
              Date.now() - this.lastBatchFlush >= this.config.batchFlushInterval) {
            await this.flushBatch();
            this.resetBatch();
          }

          // Update scan_progress after each block
          await scanDb.put("scan_progress", {
            lastBlock: height,
            transactions: {}, // Not needed for incremental sync
            lastUpdated: Date.now(),
          });

        } catch (error) {
          logger.error(`[Background Sync] Error processing block ${height}:`, error.message);
          this.syncStats.errors++;

          // If batch became invalid due to IO error, reset it for next block
          if (!this.batchIsValid) {
            logger.info("[Background Sync] Resetting batch after error");
            this.resetBatch();
          }
          // Continue with next block instead of retrying
        }
      }

      // Final batch flush
      await this.flushBatch();

      this.syncStats.lastSyncTime = new Date().toISOString();
      logger.info(`[Background Sync] Processed ${processedBlocks} blocks successfully`);
    } catch (error) {
      logger.error("[Background Sync] Error in syncNewBlocks:", error.message);
      this.batchIsValid = false;
      // Don't throw - allow sync loop to continue
    } finally {
      this.mainDb = null;
    }
  }

  async processBlock(block, db, scanDb) {
    const taintedOutBatch = scanDb.batch();
    const callbackPromises = [];
    let taintedOutCount = 0;
    const blockTaintedOutpoints = new Map();

    for (const tx of block.tx) {
      const txid = tx.txid || tx.hash;
      let isTaintSpreading = false;
      let minDegree = Infinity;

      // 1. Check if any input spends a tainted output
      for (const vin of tx.vin) {
        if (vin.coinbase) continue;
        const outpoint = `${vin.txid}:${vin.vout}`;

        // First check if it was tainted in this block
        if (blockTaintedOutpoints.has(outpoint)) {
          const degree = blockTaintedOutpoints.get(outpoint);
          isTaintSpreading = true;
          if (degree < minDegree) {
            minDegree = degree;
          }
        } else {
          // Check DB for tainted outpoint
          try {
            const degree = normalizeTaintedDegree(
              await scanDb.get(`tainted_out:${outpoint}`)
            );
            if (degree !== undefined && degree !== null) {
              isTaintSpreading = true;
              if (degree < minDegree) {
                minDegree = degree;
              }
            }
          } catch (e) {
            // Not tainted, continue
          }
        }
      }

      // 2. Check if any output goes to a known Satoshi address
      const outputs = tx.vout
        .map((vout, index) => ({
          index,
          address: this.bitcoinRPC.getAddressFromScript(vout.scriptPubKey),
          value: vout.value,
        }))
        .filter((o) => o.address);

      const goesToSatoshi = outputs.some((o) =>
        SATOSHI_ADDRESS_SET.has(o.address)
      );
      if (goesToSatoshi) {
        isTaintSpreading = true;
        minDegree = -1; // Use -1 so that currentDegree = 0 (seed)
      }

      if (isTaintSpreading) {
        const currentDegree = minDegree + 1;
        const formattedTx = this.bitcoinRPC.formatTransaction(tx);

        // Find source address from tainted inputs
        let sourceAddress = null;
        for (const vin of tx.vin) {
          if (vin.coinbase) continue;
          const outpoint = `${vin.txid}:${vin.vout}`;
          
          // Check if this input is tainted
          let inputDegree = null;
          if (blockTaintedOutpoints.has(outpoint)) {
            inputDegree = blockTaintedOutpoints.get(outpoint);
          } else {
            try {
              inputDegree = normalizeTaintedDegree(
                await scanDb.get(`tainted_out:${outpoint}`)
              );
            } catch (e) {
              // Not tainted
            }
          }

          // If this input is tainted and has the minimum degree, use it as source
          if (inputDegree !== null && inputDegree === minDegree) {
            // Try to get address from prevout
            if (vin.prevout && vin.prevout.scriptPubKey) {
              sourceAddress = this.bitcoinRPC.getAddressFromScript(vin.prevout.scriptPubKey);
            } else if (formattedTx.inputs && formattedTx.inputs.length > 0) {
              // Fallback to formatted transaction inputs
              const input = formattedTx.inputs.find(
                (inp) => inp.prev_out && inp.prev_out.addr
              );
              if (input) {
                sourceAddress = input.prev_out.addr;
              }
            }
            if (sourceAddress) break; // Found source, stop looking
          }
        }

        // Process ALL outputs
        for (let index = 0; index < tx.vout.length; index++) {
          const vout = tx.vout[index];
          const outpoint = `${txid}:${index}`;

          // Check if outpoint is already tainted
          let alreadyTainted = blockTaintedOutpoints.has(outpoint);

          if (!alreadyTainted) {
            try {
              const degree = normalizeTaintedDegree(
                await scanDb.get(`tainted_out:${outpoint}`)
              );
              if (degree !== undefined && degree !== null) {
                alreadyTainted = true;
              }
            } catch (e) {
              alreadyTainted = false;
            }
          }

          if (!alreadyTainted) {
            const address = this.bitcoinRPC.getAddressFromScript(vout.scriptPubKey);

            // Store tainted outpoint in batch
            taintedOutBatch.put(`tainted_out:${outpoint}`, currentDegree);
            taintedOutCount++;
            blockTaintedOutpoints.set(outpoint, currentDegree);

            // Process address if we have one
            if (address) {
              callbackPromises.push(
                this.processAddressInBatch(
                  address,
                  currentDegree,
                  formattedTx,
                  db,
                  sourceAddress
                )
              );
            }
          }
        }
      }
    }

    // Write tainted outputs batch
    if (taintedOutCount > 0) {
      await taintedOutBatch.write();
    }

    // Execute address processing callbacks
    if (callbackPromises.length > 0) {
      await Promise.all(callbackPromises);
    }
  }

  async processAddressInBatch(address, currentDegree, transaction, db, sourceAddress = null) {
    try {
      // Check if we already have a shorter path
      try {
        const existing = await db.get(`tainted:${address}`);
        if (existing.degree <= currentDegree) {
          return; // Skip if we already have a shorter or equal path
        }
      } catch (err) {
        // Address not yet tainted, proceed
      }

      let path = [];
      let originalSatoshiAddress = address;

      // Try to get parent tainting info from sourceAddress
      let parentTinting = null;
      if (sourceAddress) {
        // Try cache first
        parentTinting = this.parentTaintingCache.get(sourceAddress);
        if (!parentTinting) {
          try {
            parentTinting = await db.get(`tainted:${sourceAddress}`);
            // Cache it
            if (this.parentTaintingCache.size > 10000) {
              const firstKey = this.parentTaintingCache.keys().next().value;
              this.parentTaintingCache.delete(firstKey);
            }
            this.parentTaintingCache.set(sourceAddress, parentTinting);
          } catch (err) {
            // Parent not found
          }
        }
      }

      if (parentTinting) {
        originalSatoshiAddress = parentTinting.originalSatoshiAddress;
        const output = transaction.out.find((o) => o.addr === address);
        const amount = output ? output.value : 0;
        path = [
          ...parentTinting.path,
          {
            from: sourceAddress,
            to: address,
            txHash: transaction.hash,
            amount: amount,
          },
        ];
      } else if (SATOSHI_ADDRESS_SET.has(address)) {
        originalSatoshiAddress = address;
      }

      // Store transaction in batch (if not already stored)
      const txKey = `tx:${transaction.hash}`;
      try {
        await db.get(txKey);
      } catch (err) {
        this.safeBatchPut(txKey, {
          hash: transaction.hash,
          time: transaction.time,
          inputs: transaction.inputs,
          outputs: transaction.out,
          degree: currentDegree,
        });
      }

      // Store tainting information in batch
      const taintData = {
        txHash: transaction.hash,
        originalSatoshiAddress,
        amount: transaction.out.find((o) => o.addr === address)?.value || 0,
        degree: currentDegree,
        path,
        lastUpdated: Date.now(),
      };

      if (this.safeBatchPut(`tainted:${address}`, taintData)) {
        this.syncStats.addressesUpdated++;
      }

      // Update cache
      if (this.parentTaintingCache.size <= 10000) {
        this.parentTaintingCache.set(address, taintData);
      } else {
        // Remove oldest entry
        const firstKey = this.parentTaintingCache.keys().next().value;
        this.parentTaintingCache.delete(firstKey);
        this.parentTaintingCache.set(address, taintData);
      }
    } catch (error) {
      logger.error(`[Background Sync] Error processing address ${address}:`, error.message);
    }
  }

  resetBatch() {
    if (this.mainDb) {
      this.mainBatch = this.mainDb.batch();
      this.batchCount = 0;
      this.lastBatchFlush = Date.now();
      this.batchIsValid = true;
    }
  }

  safeBatchPut(key, value) {
    if (!this.batchIsValid || !this.mainBatch) {
      // Batch is invalid, skip this operation
      return false;
    }
    try {
      this.mainBatch.put(key, value);
      this.batchCount++;
      return true;
    } catch (error) {
      // Batch became invalid (closed/written)
      logger.error("[Background Sync] Batch operation failed, marking batch as invalid:", error.message);
      this.batchIsValid = false;
      return false;
    }
  }

  async flushBatch() {
    if (this.mainBatch && this.batchCount > 0 && this.batchIsValid) {
      try {
        await this.mainBatch.write();
        this.batchCount = 0;
        this.batchIsValid = false; // Batch is consumed after write
      } catch (error) {
        logger.error("[Background Sync] Error flushing batch:", error.message);
        this.batchIsValid = false;
        // Don't throw - let the caller handle recovery
      }
    }
  }

  getStatus() {
    const blocksBehind = this.currentHeight !== null && this.lastProcessedBlock !== null
      ? this.currentHeight - this.lastProcessedBlock
      : null;

    const progress = this.currentHeight !== null && this.lastProcessedBlock !== null && this.currentHeight > 0
      ? ((this.lastProcessedBlock / this.currentHeight) * 100).toFixed(2)
      : null;

    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      lastProcessedBlock: this.lastProcessedBlock,
      currentHeight: this.currentHeight,
      blocksBehind,
      progress: progress !== null ? `${progress}%` : null,
      stats: this.syncStats,
      config: {
        syncInterval: this.config.syncInterval,
        enabled: this.config.enabled,
        batchSize: this.config.batchSize,
        batchFlushInterval: this.config.batchFlushInterval,
        chunkSize: this.config.chunkSize,
      },
    };
  }
}

// Export singleton instance
module.exports = new BackgroundSyncService();
module.exports.BackgroundSyncService = BackgroundSyncService;
