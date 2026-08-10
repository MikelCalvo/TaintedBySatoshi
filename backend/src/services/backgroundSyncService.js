require("dotenv").config();
const dbService = require("./dbService");
const bitcoinRPC = require("./bitcoinRPC");
const logger = require("../utils/logger");
const path = require("path");
const fs = require("fs");
const {
  normalizeTaintedDegree,
  normalizeTaintedOutpoint,
} = require("./syncUtils");

// Load Satoshi addresses
let SATOSHI_ADDRESSES = [];
let SATOSHI_ADDRESS_SET = new Set();
let ADDRESS_METADATA = {};
function loadSatoshiAddresses() {
  try {
    const satoshiData = require("../../data/satoshiAddresses");
    SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
    SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
    ADDRESS_METADATA = satoshiData.ADDRESS_METADATA || {};
    return SATOSHI_ADDRESSES.length > 0;
  } catch (err) {
    return false;
  }
}

function boundedPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

class BackgroundSyncService {
  constructor(dependencies = {}) {
    this.bitcoinRPC = dependencies.bitcoinRPC || bitcoinRPC;
    this.dbService = dependencies.dbService || dbService;
    this.logger = dependencies.logger || logger;
    this.now = dependencies.now || Date.now;
    this.ensureInitializedOverride = dependencies.ensureInitialized || null;
    this.startSyncLoopOverride = dependencies.startSyncLoop || null;
    if (dependencies.satoshiAddresses) {
      SATOSHI_ADDRESSES = dependencies.satoshiAddresses;
      SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
    }
    if (dependencies.addressMetadata) {
      ADDRESS_METADATA = dependencies.addressMetadata;
    }
    this.isRunning = false;
    this.isSyncing = false;
    this.phase = "stopped";
    this.lastError = null;
    this.currentBlock = null;
    this.activeSync = null;
    this.committedBlocks = [];
    this.blockMetrics = [];
    this.windowMetrics = null;
    this.activeBlockMetrics = null;
    this.durableCheckpoint = { height: null, hash: null, updatedAt: null };
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
      chunkSize: boundedPositiveInt(process.env.CHUNK_SIZE, 100, 500),
      prefetchConcurrency: boundedPositiveInt(
        process.env.SYNC_PREFETCH_CONCURRENCY,
        8,
        32
      ),
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
      this.phase = "initializing";
      this.logger.info("Background sync service initializing...");

      try {
        await this.bitcoinRPC.initialize();
        const initialize = this.ensureInitializedOverride
          ? this.ensureInitializedOverride
          : () => this.ensureInitialized();
        await initialize();
        this.dbReady = true;
        this.phase = "ready";
      } catch (error) {
        this.logger.error("Failed to initialize background sync:", error.message);
        this.isRunning = false;
        this.dbReady = false;
        this.phase = "failed";
        this.lastError = { message: error.message, timestamp: Date.now() };
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
    const scanDb = await this.dbService.init();

    try {
      logger.info("🔍 Initializing Satoshi coinbase outputs as tainted...");
      logger.info(`Using ${SATOSHI_ADDRESSES.length.toLocaleString()} Patoshi addresses`);
      logger.info(`📚 Source: https://github.com/bensig/patoshi-addresses`);
      logger.info(`   Patoshi Pattern Analysis by Sergio Demian Lerner`);
      logger.info(`   https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/`);
      logger.info("\nScanning Patoshi blocks to extract coinbase outputs...");

      const coinbaseBatch = scanDb.batch();
      let initCount = 0;

      const allBlocks = this.getSeedBlockHeights();

      for (let i = 0; i < allBlocks.length; i++) {
        const height = allBlocks[i];

        if (i % 1000 === 0) {
          logger.info(
            `  Progress: ${i}/${allBlocks.length} (${((i / allBlocks.length) * 100).toFixed(1)}%)`
          );
        }

        const hash = await this.bitcoinRPC.call("getblockhash", [height]);
        const block = await this.bitcoinRPC.call("getblock", [hash, 2]);
        const coinbaseTx = block.tx[0];

        // Mark each coinbase output as tainted. Any failure aborts the full
        // initialization so the ready marker can never describe partial data.
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
          // Keep the pipeline full while catching up. The sync method already
          // provides DB and RPC backpressure.
          nextInterval = 0;
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
      const scanDb = db;
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

  getSeedBlockHeights() {
    const metadataHeights = Object.values(ADDRESS_METADATA)
      .map((metadata) => metadata?.blockHeight)
      .filter(Number.isInteger);
    return [...new Set([0, 1, 2, ...metadataHeights])].sort((a, b) => a - b);
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

    if (this.activeSync) {
      await this.activeSync;
    }

    await this.flushBatch();
    await this.dbService.close?.();
    this.batchIsValid = false;
    this.mainDb = null;
    this.dbReady = false;
    this.phase = "stopped";

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
      this.phase = "syncing";

      // Get current blockchain height
      const blockchainInfo = await this.bitcoinRPC.getBlockchainInfo();
      this.currentHeight = blockchainInfo.blocks;

      // Scan state lives in the same LevelDB as taint records so one batch can
      // atomically commit all block effects and the checkpoint.
      const scanDb = await this.dbService.init();
      let lastProcessedBlock = -1;
      let progress = null;

      try {
        progress = await scanDb.get("scan_progress");
      } catch (err) {
        if (err.code !== "LEVEL_NOT_FOUND") throw err;
      }

      if (progress) {
        await this.verifyCheckpoint(progress);
        lastProcessedBlock = progress.lastBlock ?? -1;
        this.durableCheckpoint = {
          height: lastProcessedBlock,
          hash: progress.blockHash || null,
          updatedAt: progress.lastUpdated || null,
        };
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

        this.activeSync = this.syncNewBlocks(startBlock, endBlock, scanDb);
        await this.activeSync;
      } else {
        // No new blocks, just update stats
        this.syncStats.lastSyncTime = new Date().toISOString();
      }
    } catch (error) {
      logger.error("[Background Sync] Error during sync check:", error.message);
      this.syncStats.errors++;
      this.phase = "retrying";
      this.lastError = {
        message: error.message,
        height: this.currentBlock,
        timestamp: Date.now(),
      };
    } finally {
      this.activeSync = null;
      this.isSyncing = false;
      if (this.phase === "syncing") this.phase = "ready";
    }
  }

  async syncNewBlocks(startBlock, endBlock, scanDb) {
    const db = await this.dbService.init();
    this.mainDb = db;
    let processedBlocks = 0;

    try {
      const prefetchStartedAt = this.now();
      const prefetched = this.bitcoinRPC.getBlocksWindow
        ? await this.bitcoinRPC.getBlocksWindow(
            startBlock,
            endBlock,
            this.config.prefetchConcurrency
          )
        : await Promise.all(
            Array.from(
              { length: endBlock - startBlock + 1 },
              async (_, index) => {
                const height = startBlock + index;
                const hash = await this.bitcoinRPC.call("getblockhash", [height]);
                const block = await this.bitcoinRPC.call("getblock", [hash, 2]);
                return { height, hash, block };
              }
            )
          );
      this.windowMetrics = {
        startBlock,
        endBlock,
        blocks: prefetched.length,
        prefetchMs: this.now() - prefetchStartedAt,
      };

      for (const { height, hash, block } of prefetched) {
        this.currentBlock = height;
        this.resetBatch();
        const blockStartedAt = this.now();
        this.activeBlockMetrics = {
          inputLookupMs: 0,
          mainPrefetchMs: 0,
          parentLookupMs: 0,
          parentPointReads: 0,
          externalOutpoints: 0,
          mainPrefetchKeys: 0,
          taintedTransactions: 0,
          taintedOutputs: 0,
          addressWrites: 0,
        };
        const processingStartedAt = this.now();
        const scanOperations = (await this.processBlock(block, db, scanDb)) || [];
        const processingMs = this.now() - processingStartedAt;

        for (const operation of scanOperations) {
          if (!this.safeBatchPut(operation.key, operation.value)) {
            throw new Error("Main database batch is not writable");
          }
        }
        if (!this.safeBatchPut("scan_progress", {
          lastBlock: height,
          blockHash: hash,
          schemaVersion: 3,
          lastUpdated: Date.now(),
        })) {
          throw new Error("Main database batch is not writable");
        }
        const batchOperations = this.batchCount;
        const commitStartedAt = this.now();
        await this.flushBatch();
        const commitMs = this.now() - commitStartedAt;

        this.recordBlockMetrics({
          height,
          totalMs: this.now() - blockStartedAt,
          inputLookupMs: this.activeBlockMetrics.inputLookupMs,
          mainPrefetchMs: this.activeBlockMetrics.mainPrefetchMs,
          parentLookupMs: this.activeBlockMetrics.parentLookupMs,
          parentPointReads: this.activeBlockMetrics.parentPointReads,
          processingMs,
          commitMs,
          externalOutpoints: this.activeBlockMetrics.externalOutpoints,
          mainPrefetchKeys: this.activeBlockMetrics.mainPrefetchKeys,
          taintedTransactions: this.activeBlockMetrics.taintedTransactions,
          taintedOutputs: this.activeBlockMetrics.taintedOutputs,
          addressWrites: this.activeBlockMetrics.addressWrites,
          batchOperations,
        });
        this.activeBlockMetrics = null;

        processedBlocks++;
        this.syncStats.blocksProcessed++;
        this.recordCommittedBlock(height, hash);
      }

      this.syncStats.lastSyncTime = new Date().toISOString();
      logger.info(`[Background Sync] Processed ${processedBlocks} blocks successfully`);
    } catch (error) {
      logger.error("[Background Sync] Error in syncNewBlocks:", error.message);
      this.syncStats.errors++;
      this.batchIsValid = false;
      throw error;
    } finally {
      this.activeBlockMetrics = null;
      this.mainDb = null;
    }
  }

  recordCommittedBlock(height, hash, timestamp = Date.now()) {
    this.lastProcessedBlock = height;
    this.durableCheckpoint = {
      height,
      hash,
      updatedAt: timestamp,
    };
    this.committedBlocks.push({ height, timestamp });
    if (this.committedBlocks.length > 1000) this.committedBlocks.shift();
  }

  recordBlockMetrics(metrics) {
    this.blockMetrics.push({ ...metrics });
    if (this.blockMetrics.length > 100) this.blockMetrics.shift();
  }

  getPipelineMetrics() {
    const emptyAverage = {
      total: 0,
      inputLookup: 0,
      mainPrefetch: 0,
      parentLookup: 0,
      processing: 0,
      commit: 0,
    };
    if (this.blockMetrics.length === 0) {
      return {
        samples: 0,
        averageMs: emptyAverage,
        last: null,
        slowest: null,
        window: this.windowMetrics,
      };
    }

    const average = (key) =>
      Math.round(
        this.blockMetrics.reduce(
          (sum, sample) => sum + (sample[key] || 0),
          0
        ) / this.blockMetrics.length
      );
    const slowest = this.blockMetrics.reduce((current, sample) =>
      !current || sample.totalMs > current.totalMs ? sample : current
    , null);

    return {
      samples: this.blockMetrics.length,
      averageMs: {
        total: average("totalMs"),
        inputLookup: average("inputLookupMs"),
        mainPrefetch: average("mainPrefetchMs"),
        parentLookup: average("parentLookupMs"),
        processing: average("processingMs"),
        commit: average("commitMs"),
      },
      last: this.blockMetrics.at(-1),
      slowest,
      window: this.windowMetrics,
    };
  }

  async verifyCheckpoint(progress) {
    if (!progress?.blockHash || !Number.isInteger(progress.lastBlock)) return;
    const canonicalHash = await this.bitcoinRPC.call("getblockhash", [
      progress.lastBlock,
    ]);
    if (canonicalHash !== progress.blockHash) {
      throw new Error(
        `Checkpoint hash mismatch at block ${progress.lastBlock}: expected ${progress.blockHash}, got ${canonicalHash}`
      );
    }
  }

  isReady() {
    const caughtUp =
      Number.isInteger(this.currentHeight) &&
      Number.isInteger(this.lastProcessedBlock) &&
      this.currentHeight - this.lastProcessedBlock <= 1;
    return (
      this.isRunning &&
      this.dbReady &&
      (this.phase === "ready" || (this.phase === "syncing" && caughtUp))
    );
  }

  async processBlock(block, db, scanDb) {
    const scanOperations = [];
    const blockTaintedOutpoints = new Map();
    const blockOutputAddresses = new Map();
    const externalOutpoints = [];
    const seenExternalOutpoints = new Set();
    const blockTxids = new Set(
      block.tx.map((tx) => tx.txid || tx.hash)
    );
    let mainRecords = null;

    for (const tx of block.tx) {
      for (const vin of tx.vin || []) {
        if (vin.coinbase || blockTxids.has(vin.txid)) continue;
        const outpoint = `${vin.txid}:${vin.vout}`;
        if (!seenExternalOutpoints.has(outpoint)) {
          seenExternalOutpoints.add(outpoint);
          externalOutpoints.push(outpoint);
        }
      }
    }

    const externalDegrees = new Map();
    if (externalOutpoints.length > 0) {
      const keys = externalOutpoints.map((outpoint) => `tainted_out:${outpoint}`);
      const inputLookupStartedAt = this.now();
      const values = await scanDb.getMany(keys);
      if (this.activeBlockMetrics) {
        this.activeBlockMetrics.inputLookupMs += this.now() - inputLookupStartedAt;
        this.activeBlockMetrics.externalOutpoints = externalOutpoints.length;
      }
      for (let index = 0; index < externalOutpoints.length; index++) {
        const value = values[index];
        if (value !== undefined) {
          externalDegrees.set(
            externalOutpoints[index],
            normalizeTaintedOutpoint(value)
          );
        }
      }
    }

    const taintedPlans = [];
    for (const tx of block.tx) {
      const txid = tx.txid || tx.hash;
      const inputDegrees = new Map();
      let minDegree = Infinity;

      for (const vin of tx.vin || []) {
        if (vin.coinbase) continue;
        const outpoint = `${vin.txid}:${vin.vout}`;
        const taintedInput = blockTaintedOutpoints.has(outpoint)
          ? blockTaintedOutpoints.get(outpoint)
          : externalDegrees.get(outpoint);
        if (taintedInput !== undefined) {
          inputDegrees.set(outpoint, taintedInput);
          minDegree = Math.min(minDegree, taintedInput.degree);
        }
      }

      const outputs = (tx.vout || []).map((vout, index) => ({
        index,
        address: this.bitcoinRPC.getAddressFromScript(vout.scriptPubKey),
        value: vout.value,
      }));
      for (const output of outputs) {
        if (output.address) {
          blockOutputAddresses.set(`${txid}:${output.index}`, output.address);
        }
      }
      const goesToSatoshi = outputs.some(
        (output) => output.address && SATOSHI_ADDRESS_SET.has(output.address)
      );
      if (goesToSatoshi) minDegree = -1;
      if (!Number.isFinite(minDegree)) continue;

      const currentDegree = minDegree + 1;
      const formattedTx = this.bitcoinRPC.formatTransaction(tx);
      let sourceAddress = null;

      for (const vin of tx.vin || []) {
        if (vin.coinbase) continue;
        const outpoint = `${vin.txid}:${vin.vout}`;
        const taintedInput = inputDegrees.get(outpoint);
        if (!taintedInput || taintedInput.degree !== minDegree) continue;
        if (taintedInput.address) {
          sourceAddress = taintedInput.address;
        } else if (blockOutputAddresses.has(outpoint)) {
          sourceAddress = blockOutputAddresses.get(outpoint);
        } else if (vin.prevout?.scriptPubKey) {
          sourceAddress = this.bitcoinRPC.getAddressFromScript(
            vin.prevout.scriptPubKey
          );
        } else {
          const input = formattedTx.inputs?.find(
            (candidate) => candidate.prev_out?.addr
          );
          sourceAddress = input?.prev_out?.addr || null;
        }
        if (sourceAddress) break;
      }

      for (const output of outputs) {
        const outpoint = `${txid}:${output.index}`;
        blockTaintedOutpoints.set(outpoint, {
          degree: currentDegree,
          address: output.address || null,
        });
      }
      taintedPlans.push({
        txid,
        currentDegree,
        formattedTx,
        sourceAddress,
        outputs,
      });
    }

    if (taintedPlans.length === 0) return scanOperations;

    const mainAddressKeys = new Set();
    const taintedTransactionIds = [];
    for (const plan of taintedPlans) {
      taintedTransactionIds.push(plan.txid);
      if (plan.sourceAddress) mainAddressKeys.add(plan.sourceAddress);
      for (const output of plan.outputs) {
        if (output.address) mainAddressKeys.add(output.address);
      }
    }
    const mainPrefetchStartedAt = this.now();
    mainRecords = await this.prefetchMainRecords(
      db,
      [...mainAddressKeys],
      taintedTransactionIds
    );
    if (this.activeBlockMetrics) {
      this.activeBlockMetrics.mainPrefetchMs +=
        this.now() - mainPrefetchStartedAt;
      this.activeBlockMetrics.mainPrefetchKeys =
        mainAddressKeys.size + taintedTransactionIds.length;
      this.activeBlockMetrics.taintedTransactions = taintedPlans.length;
    }

    for (const plan of taintedPlans) {
      // New txid:vout pairs are unique in a chronological scan. Replays are
      // safe because LevelDB puts are idempotent and address writes retain the
      // existing shortest path.
      for (const output of plan.outputs) {
        if (this.activeBlockMetrics) {
          this.activeBlockMetrics.taintedOutputs++;
        }
        const outpoint = `${plan.txid}:${output.index}`;
        scanOperations.push({
          key: `tainted_out:${outpoint}`,
          value: {
            degree: plan.currentDegree,
            address: output.address || null,
          },
        });

        if (output.address) {
          await this.processAddressInBatch(
            output.address,
            plan.currentDegree,
            plan.formattedTx,
            db,
            plan.sourceAddress,
            mainRecords
          );
        }
      }
    }

    return scanOperations;
  }

  async prefetchMainRecords(db, addresses, transactionIds) {
    const keys = [
      ...addresses.map((address) => `tainted:${address}`),
      ...transactionIds.map((txid) => `tx:${txid}`),
    ];
    const records = new Map();
    if (keys.length === 0) return records;
    const values = await db.getMany(keys);
    keys.forEach((key, index) => records.set(key, values[index]));
    return records;
  }

  async processAddressInBatch(
    address,
    currentDegree,
    transaction,
    db,
    sourceAddress = null,
    mainRecords = null
  ) {
    const addressKey = `tainted:${address}`;
    let existing;
    if (mainRecords) {
      existing = mainRecords.get(addressKey);
    } else {
      try {
        existing = await db.get(addressKey);
      } catch (err) {
        if (err.code !== "LEVEL_NOT_FOUND") throw err;
      }
    }
    if (existing && existing.degree <= currentDegree) return;

    let originalSatoshiAddress = address;
    let parentTinting = null;

    if (sourceAddress) {
      parentTinting = this.parentTaintingCache.get(sourceAddress);
      if (!parentTinting && mainRecords) {
        parentTinting = mainRecords.get(`tainted:${sourceAddress}`);
      }
      if (!parentTinting) {
        try {
          const parentLookupStartedAt = this.now();
          parentTinting = await db.get(`tainted:${sourceAddress}`);
          if (this.activeBlockMetrics) {
            this.activeBlockMetrics.parentLookupMs +=
              this.now() - parentLookupStartedAt;
            this.activeBlockMetrics.parentPointReads++;
          }
          if (this.parentTaintingCache.size > 10000) {
            const firstKey = this.parentTaintingCache.keys().next().value;
            this.parentTaintingCache.delete(firstKey);
          }
          this.parentTaintingCache.set(sourceAddress, parentTinting);
        } catch (err) {
          if (err.code !== "LEVEL_NOT_FOUND") throw err;
        }
      }
    }

    if (parentTinting) {
      originalSatoshiAddress = parentTinting.originalSatoshiAddress;
    } else if (SATOSHI_ADDRESS_SET.has(address)) {
      originalSatoshiAddress = address;
    }

    const txKey = `tx:${transaction.hash}`;
    let transactionExists;
    if (mainRecords) {
      transactionExists = Boolean(mainRecords.get(txKey));
    } else {
      try {
        transactionExists = Boolean(await db.get(txKey));
      } catch (err) {
        if (err.code !== "LEVEL_NOT_FOUND") throw err;
      }
    }
    if (!transactionExists && !this.safeBatchPut(txKey, {
      hash: transaction.hash,
      time: transaction.time,
      inputs: transaction.inputs,
      outputs: transaction.out,
      degree: currentDegree,
    })) {
      throw new Error("Main database batch is not writable");
    }

    const amount =
      transaction.out.find((candidate) => candidate.addr === address)?.value || 0;
    const taintData = {
      txHash: transaction.hash,
      originalSatoshiAddress,
      amount,
      degree: currentDegree,
      parentAddress: parentTinting ? sourceAddress : null,
      edge: parentTinting
        ? {
            from: sourceAddress,
            to: address,
            txHash: transaction.hash,
            amount,
          }
        : null,
      lastUpdated: Date.now(),
    };

    if (!this.safeBatchPut(addressKey, taintData)) {
      throw new Error("Main database batch is not writable");
    }
    if (this.activeBlockMetrics) {
      this.activeBlockMetrics.addressWrites++;
    }
    if (mainRecords) {
      mainRecords.set(addressKey, taintData);
      mainRecords.set(txKey, transactionExists || transaction);
    }
    this.syncStats.addressesUpdated++;

    if (this.parentTaintingCache.size > 10000) {
      const firstKey = this.parentTaintingCache.keys().next().value;
      this.parentTaintingCache.delete(firstKey);
    }
    this.parentTaintingCache.set(address, taintData);
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
      throw error;
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
        throw error;
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
      phase: this.phase,
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      lastProcessedBlock: this.lastProcessedBlock,
      currentHeight: this.currentHeight,
      blocksBehind,
      progress: progress !== null ? `${progress}%` : null,
      currentBlock: this.currentBlock,
      durableCheckpoint: this.durableCheckpoint,
      lastError: this.lastError,
      metrics: {
        blocksPerSecond:
          this.committedBlocks.length >= 2
            ? (this.committedBlocks.length - 1) /
              ((this.committedBlocks.at(-1).timestamp -
                this.committedBlocks[0].timestamp) /
                1000)
            : 0,
        pipeline: this.getPipelineMetrics(),
      },
      stats: this.syncStats,
      config: {
        syncInterval: this.config.syncInterval,
        enabled: this.config.enabled,
        batchSize: this.config.batchSize,
        batchFlushInterval: this.config.batchFlushInterval,
        chunkSize: this.config.chunkSize,
        prefetchConcurrency: this.config.prefetchConcurrency,
      },
    };
  }
}

// Export singleton instance
module.exports = new BackgroundSyncService();
module.exports.BackgroundSyncService = BackgroundSyncService;
