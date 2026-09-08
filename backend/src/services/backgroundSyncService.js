const dbService = require("./dbService");
const bitcoinRPC = require("./bitcoinRPC");
const logger = require("../utils/logger");
const path = require("path");
const fs = require("fs");
const {
  processBlockTaint,
  mergeAddressRecord,
  netMutations,
} = require("./taintEngine");

const SCHEMA_VERSION = 4;

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

function boundedPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function boundedDegree(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
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
    this.isRunning = false;
    this.isSyncing = false;
    this.phase = "stopped";
    this.lastError = null;
    this.currentBlock = null;
    this.activeSync = null;
    this.committedBlocks = [];
    this.blockMetrics = [];
    this.windowMetrics = null;
    this.prefetchedWindow = null;
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
    this.taintStats = {
      liveOutpoints: 0,
      taintedWallets: 0,
    };

    this.config = {
      syncInterval: parseInt(process.env.SYNC_INTERVAL) || 10 * 60 * 1000,
      enabled: process.env.SYNC_ENABLED !== "false",
      batchSize: parseInt(process.env.BATCH_SIZE) || 1000,
      batchFlushInterval: parseInt(process.env.BATCH_FLUSH_INTERVAL) || 5000,
      chunkSize: boundedPositiveInt(process.env.CHUNK_SIZE, 100, 500),
      prefetchConcurrency: boundedPositiveInt(
        process.env.SYNC_PREFETCH_CONCURRENCY,
        8,
        32
      ),
      maxDegree: boundedDegree(process.env.MAX_DEGREE),
      liveUtxoCacheSize: boundedPositiveInt(
        process.env.LIVE_UTXO_CACHE_SIZE,
        250000,
        1000000
      ),
      addressCacheSize: boundedPositiveInt(
        process.env.ADDRESS_CACHE_SIZE,
        250000,
        1000000
      ),
    };

    this.mainBatch = null;
    this.batchCount = 0;
    this.lastBatchFlush = Date.now();
    this.batchIsValid = false;
    this.mainDb = null;
    this.dbReady = false;
    this.starting = null;
    this.liveCache = new Map();
    this.addressCache = new Map();
  }

  rememberBounded(cache, limit, key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
  }

  getBounded(cache, key) {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  rememberLiveOutpoint(outpoint, record) {
    this.rememberBounded(
      this.liveCache,
      this.config.liveUtxoCacheSize,
      outpoint,
      record
    );
  }

  getCachedLiveOutpoint(outpoint) {
    return this.getBounded(this.liveCache, outpoint);
  }

  rememberAddress(address, record) {
    this.rememberBounded(
      this.addressCache,
      this.config.addressCacheSize,
      address,
      record
    );
  }

  getCachedAddress(address) {
    return this.getBounded(this.addressCache, address);
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

  seedRecord(address) {
    return { d: 0, p: null, t: null, n: 0, o: address };
  }

  async initializeSeedWallets(db) {
    const scanDb = db || (await this.dbService.init());
    const batch = scanDb.batch();
    for (const address of SATOSHI_ADDRESSES) {
      batch.put(`a:${address}`, this.seedRecord(address));
    }
    batch.put("seeds_initialized", {
      count: SATOSHI_ADDRESSES.length,
      timestamp: Date.now(),
    });
    await batch.write();
    this.taintStats.taintedWallets = SATOSHI_ADDRESSES.length;
    this.logger.info(
      `Initialized ${SATOSHI_ADDRESSES.length.toLocaleString()} Satoshi wallets at 0 hops`
    );
  }

  async ensureSeedWallets(db) {
    const scanDb = db || (await this.dbService.init());
    let marker = null;
    try {
      marker = await scanDb.get("seeds_initialized");
    } catch (err) {
      if (err.code !== "LEVEL_NOT_FOUND") throw err;
    }
    if (marker?.count === SATOSHI_ADDRESSES.length) {
      this.taintStats.taintedWallets = Math.max(
        this.taintStats.taintedWallets,
        SATOSHI_ADDRESSES.length
      );
      return;
    }

    const keys = SATOSHI_ADDRESSES.map((address) => `a:${address}`);
    const existing = keys.length > 0 ? await scanDb.getMany(keys) : [];
    const batch = scanDb.batch();
    let missing = 0;
    for (let index = 0; index < SATOSHI_ADDRESSES.length; index++) {
      if (existing[index]) continue;
      batch.put(`a:${SATOSHI_ADDRESSES[index]}`, this.seedRecord(SATOSHI_ADDRESSES[index]));
      missing += 1;
    }
    batch.put("seeds_initialized", {
      count: SATOSHI_ADDRESSES.length,
      timestamp: Date.now(),
    });
    await batch.write();
    this.taintStats.taintedWallets = Math.max(
      this.taintStats.taintedWallets,
      SATOSHI_ADDRESSES.length
    );
    this.logger.info(
      missing > 0
        ? `Initialized ${missing.toLocaleString()} missing Satoshi wallets at 0 hops`
        : `Satoshi wallet seed marker written for ${SATOSHI_ADDRESSES.length.toLocaleString()} addresses`
    );
  }

  startSyncLoop() {
    const syncLoop = async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.checkAndSync();
      } catch (err) {
        this.logger.error("Error in sync loop:", err.message);
        this.syncStats.errors++;
      }

      let nextInterval;
      if (this.currentHeight && this.lastProcessedBlock !== null) {
        const blocksBehind = this.currentHeight - this.lastProcessedBlock;
        if (blocksBehind > 1000) {
          nextInterval = 0;
        } else if (blocksBehind > 100) {
          nextInterval = 30000;
        } else if (blocksBehind > 0) {
          nextInterval = 2 * 60 * 1000;
        } else {
          nextInterval = this.config.syncInterval;
        }
      } else {
        nextInterval = 30000;
      }

      this.syncInterval = setTimeout(syncLoop, nextInterval);
    };

    syncLoop();
  }

  async ensureInitialized() {
    try {
      this.logger.info("[Init] Step 1: Checking data directory...");
      const satoshiAddressesPath = path.join(
        __dirname,
        "../../data/satoshiAddresses.js"
      );
      const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data");

      if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
      }

      if (!fs.existsSync(satoshiAddressesPath)) {
        this.logger.info("[Init] Patoshi addresses not found, extracting before sync...");
        const { extractPatoshiAddresses } = require("../scripts/extractPatoshiAddresses");
        await extractPatoshiAddresses();
      }

      this.logger.info("[Init] Step 2: Loading Satoshi addresses...");
      if (!loadSatoshiAddresses()) {
        throw new Error("Failed to load Satoshi addresses");
      }
      if (SATOSHI_ADDRESSES.length === 0) {
        throw new Error("No Satoshi addresses found in satoshiAddresses.js");
      }
      this.logger.info(
        `[Init] Loaded ${SATOSHI_ADDRESSES.length.toLocaleString()} Satoshi addresses`
      );

      this.logger.info("[Init] Step 3: Initializing main database...");
      const db = await this.dbService.init();
      this.dbReady = true;
      this.logger.info("[Init] Main database ready");

      this.logger.info("[Init] Step 4: Checking Satoshi wallet seeds...");
      await this.ensureSeedWallets(db);
      this.logger.info("[Init] Initialization checks completed");
    } catch (error) {
      this.logger.error("[Init] Error during initialization:", error.message);
      this.logger.error(error.stack);
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

    if (this.activeSync) {
      await this.activeSync;
    }

    await this.flushBatch();
    await this.dbService.close?.();
    this.batchIsValid = false;
    this.mainDb = null;
    this.dbReady = false;
    this.phase = "stopped";

    this.logger.info("Background sync service stopped");
  }

  async checkAndSync() {
    if (this.isSyncing) {
      return;
    }

    if (!this.dbReady) {
      this.logger.info("[Background Sync] Waiting for database initialization...");
      return;
    }

    try {
      this.isSyncing = true;
      this.phase = "syncing";

      const blockchainInfo = await this.bitcoinRPC.getBlockchainInfo();
      this.currentHeight = blockchainInfo.blocks;

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
        if (Number.isInteger(progress.liveOutpoints)) {
          this.taintStats.liveOutpoints = progress.liveOutpoints;
        }
        if (Number.isInteger(progress.taintedWallets)) {
          this.taintStats.taintedWallets = progress.taintedWallets;
        }
      }

      this.lastProcessedBlock = lastProcessedBlock;

      if (this.currentHeight > lastProcessedBlock) {
        const startBlock = lastProcessedBlock + 1;
        const endBlock = Math.min(
          startBlock + this.config.chunkSize - 1,
          this.currentHeight
        );
        const remainingBlocks = this.currentHeight - lastProcessedBlock;

        this.logger.info(
          `[Background Sync] Processing chunk: blocks ${startBlock}-${endBlock} (${remainingBlocks.toLocaleString()} remaining)`
        );

        this.activeSync = this.syncNewBlocks(startBlock, endBlock, scanDb);
        await this.activeSync;
      } else {
        this.syncStats.lastSyncTime = new Date().toISOString();
      }
    } catch (error) {
      this.logger.error("[Background Sync] Error during sync check:", error.message);
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

  applyWindowMutation(puts, dels, type, key, value) {
    if (type === "del") {
      if (puts.has(key)) {
        puts.delete(key);
        return;
      }
      dels.add(key);
      return;
    }
    dels.delete(key);
    puts.set(key, value);
  }

  fetchBlocksWindow(startBlock, endBlock) {
    if (this.bitcoinRPC.getBlocksWindow) {
      return this.bitcoinRPC.getBlocksWindow(
        startBlock,
        endBlock,
        this.config.prefetchConcurrency
      );
    }
    return Promise.all(
      Array.from({ length: endBlock - startBlock + 1 }, async (_, index) => {
        const height = startBlock + index;
        const hash = await this.bitcoinRPC.call("getblockhash", [height]);
        const block = await this.bitcoinRPC.call("getblock", [hash, 2]);
        return { height, hash, block };
      })
    );
  }

  scheduleWindowPrefetch(startBlock, endBlock) {
    if (startBlock > endBlock) return;
    const range = { startBlock, endBlock };
    const startedAt = this.now();
    const promise = this.fetchBlocksWindow(startBlock, endBlock);
    // A subsequent sync consumes and surfaces a prefetch failure. Attach a no-op
    // observer now so a failed speculative request never becomes unhandled.
    promise.catch(() => {});
    this.prefetchedWindow = { range, startedAt, promise };
  }

  async loadBlocksWindow(startBlock, endBlock) {
    const cached = this.prefetchedWindow;
    if (
      cached &&
      cached.range.startBlock === startBlock &&
      cached.range.endBlock === endBlock
    ) {
      this.prefetchedWindow = null;
      return { blocks: await cached.promise, prefetchMs: this.now() - cached.startedAt };
    }
    const startedAt = this.now();
    return {
      blocks: await this.fetchBlocksWindow(startBlock, endBlock),
      prefetchMs: this.now() - startedAt,
    };
  }

  async syncNewBlocks(startBlock, endBlock, scanDb) {
    const db = await this.dbService.init();
    this.mainDb = db;
    let processedBlocks = 0;

    try {
      const syncStartedAt = this.now();
      const { blocks: prefetched, prefetchMs } = await this.loadBlocksWindow(
        startBlock,
        endBlock
      );
      this.windowMetrics = {
        startBlock,
        endBlock,
        blocks: prefetched.length,
        prefetchMs,
        commitMs: 0,
        totalMs: 0,
        blocksPerSecond: 0,
      };

      const nextStartBlock = endBlock + 1;
      const nextEndBlock = Math.min(
        nextStartBlock + this.config.chunkSize - 1,
        this.currentHeight ?? endBlock
      );
      if (nextStartBlock <= nextEndBlock) {
        this.scheduleWindowPrefetch(nextStartBlock, nextEndBlock);
      }

      const windowPuts = new Map();
      const windowDels = new Set();
      const blockTimings = [];
      let newWallets = 0;
      let lastHeight = null;
      let lastHash = null;

      for (const { height, hash, block } of prefetched) {
        this.currentBlock = height;
        const blockStartedAt = this.now();
        this.activeBlockMetrics = {
          inputLookupMs: 0,
          addressPrefetchMs: 0,
          externalOutpoints: 0,
          addressPrefetchKeys: 0,
          taintedOutputs: 0,
          spentOutpoints: 0,
          addressWrites: 0,
        };
        const processingStartedAt = this.now();
        const mutations = await this.processBlock(block, db);
        const processingMs = this.now() - processingStartedAt;

        for (const outpoint of mutations.spent || []) {
          this.applyWindowMutation(windowPuts, windowDels, "del", `u:${outpoint}`);
        }
        for (const { outpoint, record } of mutations.created || []) {
          this.applyWindowMutation(
            windowPuts,
            windowDels,
            "put",
            `u:${outpoint}`,
            record
          );
        }
        for (const { address, record } of mutations.addresses || []) {
          this.applyWindowMutation(
            windowPuts,
            windowDels,
            "put",
            `a:${address}`,
            record
          );
        }
        newWallets += mutations.newWallets || 0;
        lastHeight = height;
        lastHash = hash;
        blockTimings.push({
          height,
          totalMs: this.now() - blockStartedAt,
          inputLookupMs: this.activeBlockMetrics.inputLookupMs,
          addressPrefetchMs: this.activeBlockMetrics.addressPrefetchMs,
          processingMs,
          commitMs: 0,
          externalOutpoints: this.activeBlockMetrics.externalOutpoints,
          addressPrefetchKeys: this.activeBlockMetrics.addressPrefetchKeys,
          taintedOutputs: this.activeBlockMetrics.taintedOutputs,
          spentOutpoints: this.activeBlockMetrics.spentOutpoints,
          addressWrites: this.activeBlockMetrics.addressWrites,
        });
        this.activeBlockMetrics = null;
        processedBlocks++;
      }

      this.resetBatch();
      for (const key of windowDels) {
        if (!this.safeBatchDel(key)) {
          throw new Error("Main database batch is not writable");
        }
      }
      for (const [key, value] of windowPuts) {
        if (!this.safeBatchPut(key, value)) {
          throw new Error("Main database batch is not writable");
        }
      }

      const nextLiveOutpoints =
        this.taintStats.liveOutpoints +
        [...windowPuts.keys()].filter((key) => key.startsWith("u:")).length -
        [...windowDels].filter((key) => key.startsWith("u:")).length;
      const nextTaintedWallets = this.taintStats.taintedWallets + newWallets;

      if (
        lastHeight !== null &&
        !this.safeBatchPut("scan_progress", {
          lastBlock: lastHeight,
          blockHash: lastHash,
          schemaVersion: SCHEMA_VERSION,
          lastUpdated: Date.now(),
          liveOutpoints: nextLiveOutpoints,
          taintedWallets: nextTaintedWallets,
        })
      ) {
        throw new Error("Main database batch is not writable");
      }

      const batchOperations = this.batchCount;
      const commitStartedAt = this.now();
      await this.flushBatch();
      const commitMs = this.now() - commitStartedAt;
      this.windowMetrics.commitMs = commitMs;
      this.windowMetrics.totalMs = this.now() - syncStartedAt;
      this.windowMetrics.blocksPerSecond =
        this.windowMetrics.totalMs > 0
          ? Number(
              ((processedBlocks * 1000) / this.windowMetrics.totalMs).toFixed(3)
            )
          : 0;
      this.taintStats.liveOutpoints = nextLiveOutpoints;
      this.taintStats.taintedWallets = nextTaintedWallets;
      this.syncStats.addressesUpdated += newWallets;
      this.syncStats.blocksProcessed += processedBlocks;

      for (const timing of blockTimings) {
        const isLast = timing.height === lastHeight;
        this.recordBlockMetrics({
          ...timing,
          commitMs: isLast ? commitMs : 0,
          totalMs: timing.totalMs + (isLast ? commitMs : 0),
          batchOperations: isLast ? batchOperations : 0,
        });
      }
      if (lastHeight !== null) {
        this.recordCommittedBlock(lastHeight, lastHash);
      }

      this.syncStats.lastSyncTime = new Date().toISOString();
      this.logger.info(
        `[Background Sync] Processed ${processedBlocks} blocks successfully`
      );
    } catch (error) {
      this.logger.error("[Background Sync] Error in syncNewBlocks:", error.message);
      this.syncStats.errors++;
      this.batchIsValid = false;
      this.liveCache.clear();
      this.addressCache.clear();
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
      addressPrefetch: 0,
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
        this.blockMetrics.reduce((sum, sample) => sum + (sample[key] || 0), 0) /
          this.blockMetrics.length
      );
    const slowest = this.blockMetrics.reduce(
      (current, sample) =>
        !current || sample.totalMs > current.totalMs ? sample : current,
      null
    );

    return {
      samples: this.blockMetrics.length,
      averageMs: {
        total: average("totalMs"),
        inputLookup: average("inputLookupMs"),
        addressPrefetch: average("addressPrefetchMs"),
        processing: average("processingMs"),
        commit: average("commitMs"),
      },
      last: this.blockMetrics.at(-1),
      slowest,
      window: this.windowMetrics,
    };
  }

  async verifyCheckpoint(progress) {
    if (!progress) return;
    if (progress.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `Incompatible database schema ${progress.schemaVersion}; expected ${SCHEMA_VERSION}. Wipe the taint database and rescan.`
      );
    }
    if (!progress.blockHash || !Number.isInteger(progress.lastBlock)) return;
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

  mapBlock(block) {
    return {
      ...block,
      tx: (block.tx || []).map((tx) => ({
        ...tx,
        txid: tx.txid || tx.hash,
        vout: (tx.vout || []).map((vout) => ({
          value: vout.value,
          scriptPubKey: {
            address: this.bitcoinRPC.getAddressFromScript
              ? this.bitcoinRPC.getAddressFromScript(vout.scriptPubKey)
              : vout.scriptPubKey?.address || null,
          },
        })),
      })),
    };
  }

  async processBlock(block, db) {
    const mapped = this.mapBlock(block);
    const blockTxids = new Set(mapped.tx.map((tx) => tx.txid));
    const externalOutpoints = [];
    const seenExternalOutpoints = new Set();

    for (const tx of mapped.tx) {
      for (const vin of tx.vin || []) {
        if (vin.coinbase || blockTxids.has(vin.txid)) continue;
        const outpoint = `${vin.txid}:${vin.vout}`;
        if (!seenExternalOutpoints.has(outpoint)) {
          seenExternalOutpoints.add(outpoint);
          externalOutpoints.push(outpoint);
        }
      }
    }

    const fetchedOutpoints = new Map();
    const cachedOutpoints = new Map();
    const missingOutpoints = externalOutpoints.filter((outpoint) => {
      const cached = this.getCachedLiveOutpoint(outpoint);
      if (cached === undefined) return true;
      cachedOutpoints.set(outpoint, cached);
      return false;
    });
    if (missingOutpoints.length > 0) {
      const keys = missingOutpoints.map((outpoint) => `u:${outpoint}`);
      const inputLookupStartedAt = this.now();
      const values = await db.getMany(keys);
      if (this.activeBlockMetrics) {
        this.activeBlockMetrics.inputLookupMs += this.now() - inputLookupStartedAt;
        this.activeBlockMetrics.externalOutpoints = missingOutpoints.length;
      }
      for (let index = 0; index < missingOutpoints.length; index++) {
        const value = values[index];
        if (value) fetchedOutpoints.set(missingOutpoints[index], value);
      }
    } else if (this.activeBlockMetrics) {
      this.activeBlockMetrics.externalOutpoints = externalOutpoints.length;
    }

    const raw = processBlockTaint(mapped, {
      isSeedAddress: (address) => SATOSHI_ADDRESS_SET.has(address),
      getOutpoint: (outpoint) =>
        cachedOutpoints.get(outpoint) || fetchedOutpoints.get(outpoint),
      maxDegree: this.config.maxDegree,
    });
    const mutations = netMutations(raw);

    if (this.activeBlockMetrics) {
      this.activeBlockMetrics.taintedOutputs = mutations.created.length;
      this.activeBlockMetrics.spentOutpoints = mutations.spent.length;
    }

    for (const outpoint of mutations.spent || []) {
      this.liveCache.delete(outpoint);
    }
    for (const { outpoint, record } of mutations.created || []) {
      this.rememberLiveOutpoint(outpoint, record);
    }

    if (mutations.created.length === 0 && mutations.addresses.length === 0) {
      return { ...mutations, newWallets: 0 };
    }

    const cachedAddresses = new Map();
    const missingAddresses = mutations.addresses
      .map((entry) => entry.address)
      .filter((address) => {
        if (!address) return false;
        const cached = this.getCachedAddress(address);
        if (cached === undefined) return true;
        cachedAddresses.set(address, cached);
        return false;
      });
    if (missingAddresses.length > 0) {
      const addressKeys = missingAddresses.map((address) => `a:${address}`);
      const addressPrefetchStartedAt = this.now();
      const existingAddresses = await db.getMany(addressKeys);
      if (this.activeBlockMetrics) {
        this.activeBlockMetrics.addressPrefetchMs +=
          this.now() - addressPrefetchStartedAt;
        this.activeBlockMetrics.addressPrefetchKeys = addressKeys.length;
      }
      for (let index = 0; index < missingAddresses.length; index++) {
        const existing = existingAddresses[index];
        if (existing !== undefined) {
          this.rememberAddress(missingAddresses[index], existing);
          cachedAddresses.set(missingAddresses[index], existing);
        }
      }
    }

    const writableAddresses = [];
    let newWallets = 0;
    for (const entry of mutations.addresses) {
      const existing = cachedAddresses.get(entry.address);
      const merged = mergeAddressRecord(existing, entry.record);
      if (!merged) continue;
      if (!existing) newWallets += 1;
      this.rememberAddress(entry.address, merged);
      writableAddresses.push({ address: entry.address, record: merged });
    }
    if (this.activeBlockMetrics) {
      this.activeBlockMetrics.addressWrites = writableAddresses.length;
    }

    return {
      created: mutations.created,
      spent: mutations.spent,
      addresses: writableAddresses,
      newWallets,
    };
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
      return false;
    }
    try {
      this.mainBatch.put(key, value);
      this.batchCount++;
      return true;
    } catch (error) {
      this.logger.error(
        "[Background Sync] Batch operation failed, marking batch as invalid:",
        error.message
      );
      this.batchIsValid = false;
      throw error;
    }
  }

  safeBatchDel(key) {
    if (!this.batchIsValid || !this.mainBatch) {
      return false;
    }
    try {
      this.mainBatch.del(key);
      this.batchCount++;
      return true;
    } catch (error) {
      this.logger.error(
        "[Background Sync] Batch delete failed, marking batch as invalid:",
        error.message
      );
      this.batchIsValid = false;
      throw error;
    }
  }

  async flushBatch() {
    if (this.mainBatch && this.batchCount > 0 && this.batchIsValid) {
      try {
        await this.mainBatch.write();
        this.batchCount = 0;
        this.batchIsValid = false;
      } catch (error) {
        this.logger.error("[Background Sync] Error flushing batch:", error.message);
        this.batchIsValid = false;
        throw error;
      }
    }
  }

  getStatus() {
    const blocksBehind =
      this.currentHeight !== null && this.lastProcessedBlock !== null
        ? this.currentHeight - this.lastProcessedBlock
        : null;

    const progress =
      this.currentHeight !== null &&
      this.lastProcessedBlock !== null &&
      this.currentHeight > 0
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
          this.windowMetrics?.blocksPerSecond ||
          (this.committedBlocks.length >= 2
            ? (this.committedBlocks.at(-1).height -
                this.committedBlocks[0].height) /
              ((this.committedBlocks.at(-1).timestamp -
                this.committedBlocks[0].timestamp) /
                1000)
            : 0),
        pipeline: this.getPipelineMetrics(),
      },
      stats: {
        ...this.syncStats,
        liveOutpoints: this.taintStats.liveOutpoints,
        taintedWallets: this.taintStats.taintedWallets,
      },
      config: {
        syncInterval: this.config.syncInterval,
        enabled: this.config.enabled,
        batchSize: this.config.batchSize,
        batchFlushInterval: this.config.batchFlushInterval,
        chunkSize: this.config.chunkSize,
        prefetchConcurrency: this.config.prefetchConcurrency,
        maxDegree: this.config.maxDegree,
        liveUtxoCacheSize: this.config.liveUtxoCacheSize,
        addressCacheSize: this.config.addressCacheSize,
        schemaVersion: SCHEMA_VERSION,
      },
      storage: {
        levelDbCacheMb:
          (this.dbService.databaseOptions?.cacheSize || 0) / (1024 * 1024),
      },
    };
  }
}

module.exports = new BackgroundSyncService();
module.exports.BackgroundSyncService = BackgroundSyncService;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
