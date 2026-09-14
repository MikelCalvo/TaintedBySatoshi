const defaultLogger = require("../utils/logger");
const { walletHopIndexKey } = require("./walletIndexKeys");

const META_KEY = "wallet_hop_index";
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_PAUSE_MS = 100;
const MIN_ENV_BATCH_SIZE = 100;
const MAX_ENV_BATCH_SIZE = 50000;
const ITERATOR_HIGH_WATER_MARK_BYTES = 1024 * 1024;

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function walletHopIndexRange(minHops = 0, maxHops = Number.MAX_SAFE_INTEGER) {
  const min = Number.isSafeInteger(minHops) && minHops >= 0 ? minHops : 0;
  const max =
    Number.isSafeInteger(maxHops) && maxHops >= min
      ? maxHops
      : Number.MAX_SAFE_INTEGER;
  const gte = `h:${String(min).padStart(16, "0")}:`;
  const lt =
    max >= Number.MAX_SAFE_INTEGER
      ? `h:${String(Number.MAX_SAFE_INTEGER).padStart(16, "0")}:~`
      : `h:${String(max + 1).padStart(16, "0")}:`;
  return { gte, lt, fillCache: false };
}

function isIndexableDegree(degree) {
  return Number.isSafeInteger(degree) && degree >= 0;
}

function isUsableCompleteMarker(marker) {
  return (
    marker &&
    marker.version === 1 &&
    marker.complete === true &&
    marker.cursor == null &&
    Number.isSafeInteger(marker.indexed) &&
    marker.indexed >= 0
  );
}

function isUsablePartialMarker(marker) {
  if (!marker || marker.version !== 1 || marker.complete === true) return false;
  const cursorOk = marker.cursor == null || typeof marker.cursor === "string";
  const indexedOk =
    Number.isSafeInteger(marker.indexed) && marker.indexed >= 0;
  return cursorOk && indexedOk;
}

class WalletIndexService {
  constructor(options = {}) {
    this.dbService = options.dbService || require("./dbService");
    this.logger = options.logger || defaultLogger;
    this.environment = options.environment || process.env;
    this.batchSize =
      options.batchSize != null
        ? boundedInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_ENV_BATCH_SIZE)
        : boundedInt(
            this.environment.INDEX_BATCH_SIZE,
            DEFAULT_BATCH_SIZE,
            MIN_ENV_BATCH_SIZE,
            MAX_ENV_BATCH_SIZE
          );
    this.pauseMs =
      options.pauseMs != null
        ? boundedInt(options.pauseMs, DEFAULT_PAUSE_MS, 0, 60_000)
        : boundedInt(
            this.environment.INDEX_PAUSE_MS,
            DEFAULT_PAUSE_MS,
            0,
            60_000
          );
    this.sleep =
      options.sleep ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    this.resetState();
  }

  resetState() {
    this.phase = "idle";
    this.indexed = 0;
    this.total = undefined;
    this.cursor = null;
    this.maxHops = 0;
    this.error = null;
    this.stopping = false;
    this.ensurePromise = null;
    this.backfillPromise = null;
    this.readyWaiters = this.readyWaiters || [];
  }

  isReady() {
    return this.phase === "ready";
  }

  getStatus() {
    return {
      ready: this.phase === "ready",
      phase: this.phase,
      indexed: this.indexed,
      total: this.total,
      cursor: this.cursor,
      error: this.error,
    };
  }

  canRestart() {
    return (
      this.phase === "idle" ||
      this.phase === "failed" ||
      this.phase === "stopped"
    );
  }

  start() {
    if (this.canRestart()) {
      this.ensurePromise = null;
      this.backfillPromise = null;
      this.stopping = false;
      this.error = null;
    }
    void this.ensureStarted().catch(() => {});
  }

  // Restore persisted read availability only. Missing/partial indexes still wait
  // for normal seed initialization before ensureStarted may launch the backfill.
  async restoreCompleted() {
    if (this.isReady()) return true;
    if (this.phase !== "idle") return false;
    const db = await this.dbService.init();
    const marker = await this.readMarker(db);
    if (!isUsableCompleteMarker(marker)) return false;
    await this.refreshTotal(db);
    this.applyMarker(marker);
    this.phase = "ready";
    this.settleReady();
    return true;
  }

  ensureStarted() {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.begin().catch((error) => {
      this.phase = "failed";
      this.error = { message: error.message };
      this.failReady(error);
      throw error;
    });
    return this.ensurePromise;
  }

  async waitUntilReady() {
    try {
      await this.ensureStarted();
    } catch (error) {
      throw error;
    }
    if (this.backfillPromise) {
      await this.backfillPromise;
    }
    if (this.phase === "ready") return;
    if (this.phase === "failed") {
      throw new Error(this.error?.message || "wallet hop index failed");
    }
    if (this.phase === "stopped") {
      throw new Error("wallet hop index stopped");
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  async stop() {
    this.stopping = true;
    if (this.ensurePromise) {
      await this.ensurePromise.catch(() => {});
    }
    if (this.backfillPromise) {
      await this.backfillPromise.catch(() => {});
    }
    if (this.phase !== "ready") {
      this.phase = "stopped";
      this.settleStopped();
    }
  }

  async begin() {
    this.stopping = false;
    this.error = null;
    this.phase = "starting";
    const db = await this.dbService.init();
    const marker = await this.readMarker(db);
    await this.refreshTotal(db);
    if (isUsableCompleteMarker(marker)) {
      this.applyMarker(marker);
      this.phase = "ready";
      this.settleReady();
      return;
    }
    if (isUsablePartialMarker(marker)) this.applyMarker(marker);
    else {
      this.indexed = 0;
      this.cursor = null;
      this.maxHops = 0;
    }
    if (this.stopping) {
      this.phase = "stopped";
      this.settleStopped();
      return;
    }
    this.phase = "backfilling";
    this.backfillPromise = this.runBackfill();
  }

  applyMarker(marker) {
    this.indexed = Number.isSafeInteger(marker.indexed) ? marker.indexed : 0;
    this.cursor = marker.cursor ?? null;
    this.maxHops = Number.isSafeInteger(marker.maxHops) ? marker.maxHops : 0;
  }

  async readMarker(db) {
    try {
      return await db.get(META_KEY);
    } catch (error) {
      if (error.code === "LEVEL_NOT_FOUND") return null;
      throw error;
    }
  }

  async refreshTotal(db) {
    try {
      const progress = await db.get("scan_progress");
      if (Number.isSafeInteger(progress?.taintedWallets)) {
        this.total = progress.taintedWallets;
      }
    } catch (error) {
      if (error.code !== "LEVEL_NOT_FOUND") throw error;
    }
  }

  async runBackfill() {
    try {
      while (!this.stopping) {
        const complete = await this.dbService.withWriteLock(() =>
          this.processChunk()
        );
        if (complete) {
          this.phase = "ready";
          this.cursor = null;
          this.settleReady();
          return;
        }
        if (this.pauseMs > 0 && !this.stopping) {
          await this.sleep(this.pauseMs);
        }
      }
      this.phase = "stopped";
      this.settleStopped();
    } catch (error) {
      this.phase = "failed";
      this.error = { message: error.message };
      this.logger.error("Wallet hop index backfill failed", {
        error: error.message,
      });
      this.failReady(error);
    }
  }

  async processChunk() {
    const db = await this.dbService.init();
    const marker = await this.readMarker(db);
    await this.refreshTotal(db);
    const resumeFrom = isUsablePartialMarker(marker) ? marker : null;
    const cursor = resumeFrom?.cursor ?? null;
    let maxHops = Number.isSafeInteger(marker?.maxHops) ? marker.maxHops : 0;

    const iterator = db.iterator({
      gt: cursor ? `a:${cursor}` : "a:",
      lt: "b:",
      limit: this.batchSize,
      fillCache: false,
      highWaterMarkBytes: ITERATOR_HIGH_WATER_MARK_BYTES,
    });

    const rows = [];
    try {
      for await (const [key, value] of iterator) {
        if (typeof key !== "string" || !key.startsWith("a:")) continue;
        rows.push({ address: key.slice(2), record: value });
      }
    } finally {
      await iterator.close?.();
    }

    const batch = db.batch();
    let added = 0;
    for (const { address, record } of rows) {
      const degree = record?.d;
      if (!isIndexableDegree(degree)) {
        throw new TypeError(`Invalid wallet hop degree for ${address}`);
      }
      batch.put(walletHopIndexKey(address, degree), 1);
      added += 1;
      if (degree > maxHops) maxHops = degree;
    }

    const complete = rows.length < this.batchSize;
    const nextCursor = complete ? null : rows.at(-1).address;
    const nextIndexed = (resumeFrom ? resumeFrom.indexed : 0) + added;
    batch.put(META_KEY, {
      version: 1,
      complete,
      cursor: nextCursor,
      indexed: nextIndexed,
      maxHops,
      updatedAt: this.now(),
    });
    await batch.write();

    this.indexed = nextIndexed;
    this.cursor = nextCursor;
    this.maxHops = maxHops;
    return complete;
  }

  settleReady() {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  settleStopped() {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error("wallet hop index stopped"));
    }
  }

  failReady(error) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
}

const singleton = new WalletIndexService();

module.exports = singleton;
module.exports.WalletIndexService = WalletIndexService;
module.exports.walletHopIndexKey = walletHopIndexKey;
module.exports.walletHopIndexRange = walletHopIndexRange;
module.exports.META_KEY = META_KEY;
