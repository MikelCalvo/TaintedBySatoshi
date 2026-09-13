const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseService } = require("../src/services/dbService");
const {
  WalletIndexService,
  walletHopIndexKey,
  walletHopIndexRange,
} = require("../src/services/walletIndexService");

const META_KEY = "wallet_hop_index";
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function hopRecord(degree, extra = {}) {
  return { d: degree, p: extra.p ?? "seed", t: extra.t ?? "tx", n: extra.n ?? 1, o: extra.o ?? "seed" };
}

async function notFound(db, key) {
  try {
    return await db.get(key);
  } catch (error) {
    if (error.code === "LEVEL_NOT_FOUND") return undefined;
    throw error;
  }
}

async function withTempService(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tbs-hop-index-"));
  const dbService = new DatabaseService({
    dbPath: dir,
    environment: { LEVELDB_CACHE_MB: "16", LEVELDB_BLOCK_KB: "4" },
    logger: silentLogger,
  });
  const service = new WalletIndexService({
    dbService,
    logger: silentLogger,
    pauseMs: 0,
    batchSize: options.batchSize ?? 2000,
    sleep: options.sleep,
    now: options.now || (() => 1_700_000_000_000),
    ...options,
    dbService,
    logger: silentLogger,
  });
  return {
    dir,
    dbService,
    service,
    async cleanup() {
      await service.stop();
      await dbService.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function seedAddresses(db, entries) {
  const ops = entries.map(([address, degree]) => ({
    type: "put",
    key: `a:${address}`,
    value: hopRecord(degree),
  }));
  await db.batch(ops);
}

async function collectHopKeys(db) {
  const keys = [];
  for await (const [key, value] of db.iterator({ gte: "h:", lt: "i:", fillCache: false })) {
    keys.push([key, value]);
  }
  return keys;
}

async function collectAddressRecords(db) {
  const records = [];
  for await (const [key, value] of db.iterator({ gt: "a:", lt: "b:", fillCache: false })) {
    if (typeof key === "string" && key.startsWith("a:")) {
      records.push([key.slice(2), value]);
    }
  }
  return records;
}

test("walletHopIndexKey is reexported and encodes 16-digit hop bounds", () => {
  const { walletHopIndexKey: fromKeys } = require("../src/services/walletIndexKeys");
  assert.equal(walletHopIndexKey, fromKeys);
  assert.equal(walletHopIndexKey("alice", 0), "h:0000000000000000:alice");
  assert.equal(walletHopIndexKey("bob", 51), "h:0000000000000051:bob");
  assert.equal(
    walletHopIndexKey("satoshi", Number.MAX_SAFE_INTEGER),
    `h:${String(Number.MAX_SAFE_INTEGER).padStart(16, "0")}:satoshi`
  );
  assert.throws(() => walletHopIndexKey("alice", -1), TypeError);
  assert.throws(() => walletHopIndexKey("alice", 1.5), TypeError);
  assert.throws(() => walletHopIndexKey("alice", Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.throws(() => walletHopIndexKey("", 0), TypeError);
  assert.throws(() => walletHopIndexKey("has:colon", 0), TypeError);
});

test("hop index query range uses MAX_SAFE_INTEGER rather than stale metadata maxHops", () => {
  const unbounded = walletHopIndexRange();
  assert.equal(unbounded.gte, "h:0000000000000000:");
  assert.ok(unbounded.lt > `h:${String(Number.MAX_SAFE_INTEGER).padStart(16, "0")}:`);
  assert.equal(unbounded.fillCache, false);
  const bounded = walletHopIndexRange(2, 9);
  assert.equal(bounded.gte, "h:0000000000000002:");
  assert.equal(bounded.lt, "h:0000000000000010:");
  const high = walletHopIndexRange(0, Number.MAX_SAFE_INTEGER);
  assert.equal(high.gte, unbounded.gte);
  assert.equal(high.lt, unbounded.lt);
});

test("getStatus before start exposes idle progress without secrets", async () => {
  const harness = await withTempService();
  try {
    const status = harness.service.getStatus();
    assert.equal(status.ready, false);
    assert.equal(status.phase, "idle");
    assert.equal(status.indexed, 0);
    assert.equal(status.cursor, null);
    assert.equal(status.error, null);
    assert.equal("dbPath" in status, false);
    assert.equal("stack" in status, false);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(harness.dir), false);
  } finally {
    await harness.cleanup();
  }
});

test("start returns quickly and ensureStarted is single-flight", async () => {
  const harness = await withTempService({ batchSize: 1 });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["aa", 1],
      ["bb", 2],
      ["cc", 3],
    ]);

    let initCalls = 0;
    let releaseInit;
    const initGate = new Promise((resolve) => {
      releaseInit = resolve;
    });
    const originalInit = harness.dbService.init.bind(harness.dbService);
    harness.dbService.init = async () => {
      initCalls += 1;
      await initGate;
      return originalInit();
    };

    const first = harness.service.ensureStarted();
    const second = harness.service.ensureStarted();
    assert.equal(first, second);

    const startedAt = Date.now();
    const startResult = harness.service.start();
    assert.ok(startResult === undefined || typeof startResult.then === "function");
    if (startResult && typeof startResult.then === "function") {
      await Promise.race([startResult, new Promise((resolve) => setImmediate(resolve))]);
    }
    assert.ok(Date.now() - startedAt < 50);
    assert.equal(harness.service.getStatus().ready, false);

    releaseInit();
    await first;
    assert.equal(harness.service.getStatus().ready, false);
    assert.ok(["starting", "backfilling"].includes(harness.service.getStatus().phase));
    await harness.service.waitUntilReady();
    assert.equal(harness.service.getStatus().ready, true);
    assert.ok(initCalls >= 1);
  } finally {
    await harness.cleanup();
  }
});

test("complete marker is discovered and backfill is skipped", async () => {
  const harness = await withTempService();
  try {
    const db = await harness.dbService.init();
    await db.put(META_KEY, {
      version: 1,
      complete: true,
      cursor: null,
      indexed: 42,
      maxHops: 7,
      updatedAt: 123,
    });
    const iteratorCalls = [];
    const originalIterator = db.iterator.bind(db);
    db.iterator = (options) => {
      iteratorCalls.push(options);
      return originalIterator(options);
    };

    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();
    const status = harness.service.getStatus();
    assert.equal(status.ready, true);
    assert.equal(status.phase, "ready");
    assert.equal(status.indexed, 42);
    assert.equal(iteratorCalls.some((options) => options?.gt === "a:" || options?.gte === "a:"), false);
  } finally {
    await harness.cleanup();
  }
});

test("legacy or invalid complete markers cannot be served and must rebuild", async () => {
  for (const marker of [
    { version: 0, complete: true, cursor: null, indexed: 42, maxHops: 7, updatedAt: 1 },
    { version: 1, complete: true, cursor: "stale", indexed: 42, maxHops: 7, updatedAt: 1 },
    { version: 1, complete: true, cursor: null, indexed: -1, maxHops: 7, updatedAt: 1 },
    { version: 1, complete: true, cursor: null, indexed: 1.5, maxHops: 7, updatedAt: 1 },
  ]) {
    const harness = await withTempService();
    try {
      const db = await harness.dbService.init();
      await db.put(META_KEY, marker);
      await seedAddresses(db, [["rebuild-a", 3]]);
      await harness.service.ensureStarted();
      await harness.service.waitUntilReady();
      assert.equal(harness.service.getStatus().ready, true);
      assert.equal(await db.get(walletHopIndexKey("rebuild-a", 3)), 1);
      const stored = await db.get(META_KEY);
      assert.equal(stored.version, 1);
      assert.equal(stored.complete, true);
      assert.equal(stored.indexed, 1);
      assert.equal(stored.cursor, null);
    } finally {
      await harness.cleanup();
    }
  }
});

test("absent marker incrementally indexes a: records in locked batches of at most 2000", async () => {
  const pauseMs = [];
  const harness = await withTempService({
    batchSize: 2,
    pauseMs: 100,
    sleep: async (ms) => {
      pauseMs.push(ms);
    },
  });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["addr1", 0],
      ["addr2", 51],
      ["addr3", 3],
      ["addr4", 100],
    ]);
    await db.put("scan_progress", { lastBlock: 10, taintedWallets: 99, schemaVersion: 4 });
    await db.put("u:live:0", { d: 1, a: "addr1" });

    const lockCalls = [];
    const originalLock = harness.dbService.withWriteLock.bind(harness.dbService);
    harness.dbService.withWriteLock = (work) => {
      lockCalls.push(work);
      return originalLock(work);
    };
    const iteratorCalls = [];
    const originalIterator = db.iterator.bind(db);
    db.iterator = (options) => {
      iteratorCalls.push(options);
      return originalIterator(options);
    };
    const writes = [];
    const originalBatch = db.batch.bind(db);
    db.batch = (...args) => {
      const batch = originalBatch(...args);
      const ops = [];
      const put = batch.put.bind(batch);
      batch.put = (key, value) => {
        ops.push({ type: "put", key, value });
        return put(key, value);
      };
      const write = batch.write.bind(batch);
      batch.write = async () => {
        writes.push(ops.map((op) => op.key));
        return write();
      };
      return batch;
    };

    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();

    const hopKeys = await collectHopKeys(db);
    assert.deepEqual(
      hopKeys.map(([key]) => key).sort(),
      [
        walletHopIndexKey("addr1", 0),
        walletHopIndexKey("addr2", 51),
        walletHopIndexKey("addr3", 3),
        walletHopIndexKey("addr4", 100),
      ].sort()
    );
    for (const [, value] of hopKeys) {
      assert.equal(value, 1);
    }

    const marker = await db.get(META_KEY);
    assert.equal(marker.version, 1);
    assert.equal(marker.complete, true);
    assert.equal(marker.cursor, null);
    assert.equal(marker.indexed, 4);
    assert.equal(marker.maxHops, 100);
    assert.equal(marker.updatedAt, 1_700_000_000_000);

    const status = harness.service.getStatus();
    assert.equal(status.ready, true);
    assert.equal(status.phase, "ready");
    assert.equal(status.indexed, 4);
    assert.equal(status.total, 99);
    assert.equal(status.cursor, null);

    assert.ok(lockCalls.length >= 2);
    assert.ok(iteratorCalls.every((options) => options.fillCache === false));
    assert.ok(iteratorCalls.every((options) => !options.limit || options.limit <= 2000));
    assert.equal(pauseMs.length, 2);
    assert.ok(pauseMs.every((ms) => ms === 100));

    for (const keys of writes) {
      const hopPuts = keys.filter((key) => key.startsWith("h:"));
      if (hopPuts.length > 0) {
        assert.ok(keys.includes(META_KEY));
      }
    }
    assert.ok(iteratorCalls.filter((options) => String(options.gt || options.gte || "").startsWith("a")).length >= 2);
  } finally {
    await harness.cleanup();
  }
});

test("each chunk uses a fresh iterator from the durable exclusive cursor", async () => {
  const harness = await withTempService({ batchSize: 1 });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["m/1", 1],
      ["m/2", 2],
      ["m/3", 3],
    ]);
    const iteratorBounds = [];
    const originalIterator = db.iterator.bind(db);
    db.iterator = (options) => {
      if (options && (options.gt === "a:" || String(options.gt || "").startsWith("a:") || String(options.gte || "").startsWith("a:"))) {
        iteratorBounds.push({
          gt: options.gt,
          gte: options.gte,
          limit: options.limit,
          fillCache: options.fillCache,
          highWaterMarkBytes: options.highWaterMarkBytes,
        });
      }
      return originalIterator(options);
    };

    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();

    assert.equal(iteratorBounds.length, 4);
    assert.equal(iteratorBounds[0].gt, "a:");
    assert.equal(iteratorBounds[1].gt, "a:m/1");
    assert.equal(iteratorBounds[2].gt, "a:m/2");
    assert.equal(iteratorBounds[3].gt, "a:m/3");
    assert.ok(iteratorBounds.every((bounds) => bounds.fillCache === false));
    assert.ok(iteratorBounds.every((bounds) => bounds.limit === 1));
    assert.ok(
      iteratorBounds.every((bounds) => bounds.highWaterMarkBytes === 1024 * 1024)
    );
  } finally {
    await harness.cleanup();
  }
});

test("stop waits for the active locked batch and does not close the database", async () => {
  const harness = await withTempService({ batchSize: 2, pauseMs: 0 });
  let releaseChunk;
  const chunkGate = new Promise((resolve) => {
    releaseChunk = resolve;
  });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["n1", 1],
      ["n2", 2],
      ["n3", 3],
      ["n4", 4],
    ]);
    let entered = 0;
    const originalLock = harness.dbService.withWriteLock.bind(harness.dbService);
    harness.dbService.withWriteLock = (work) =>
      originalLock(async () => {
        entered += 1;
        if (entered === 1) await chunkGate;
        return work();
      });
    let closed = false;
    const originalClose = harness.dbService.close.bind(harness.dbService);
    harness.dbService.close = async () => {
      closed = true;
      return originalClose();
    };

    const started = harness.service.ensureStarted();
    await new Promise((resolve) => {
      const poll = () => (entered > 0 ? resolve() : setImmediate(poll));
      poll();
    });
    const stopPromise = harness.service.stop();
    let stopDone = false;
    void stopPromise.then(() => {
      stopDone = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopDone, false);
    releaseChunk();
    await started;
    await stopPromise;
    assert.equal(closed, false);
    assert.equal(harness.dbService.db.status, "open");
    const marker = await notFound(db, META_KEY);
    assert.equal(marker?.complete, false);
    assert.ok(marker?.cursor);
    assert.equal(harness.service.getStatus().ready, false);
    assert.equal(harness.service.getStatus().phase, "stopped");
  } finally {
    releaseChunk();
    await harness.cleanup();
  }
});

test("resume after stop continues from the durable cursor", async () => {
  const harness = await withTempService({ batchSize: 2 });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["p1", 1],
      ["p2", 2],
      ["p3", 3],
      ["p4", 4],
      ["p5", 5],
    ]);
    await db.put(META_KEY, {
      version: 1,
      complete: false,
      cursor: "p2",
      indexed: 2,
      maxHops: 2,
      updatedAt: 1,
    });
    await db.put(walletHopIndexKey("p1", 1), 1);
    await db.put(walletHopIndexKey("p2", 2), 1);

    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();

    const hopKeys = await collectHopKeys(db);
    assert.equal(hopKeys.length, 5);
    assert.deepEqual(
      hopKeys.map(([key]) => key).sort(),
      ["p1", "p2", "p3", "p4", "p5"].map((address, index) => walletHopIndexKey(address, index + 1)).sort()
    );
    const marker = await db.get(META_KEY);
    assert.equal(marker.complete, true);
    assert.equal(marker.indexed, 5);
    assert.equal(marker.cursor, null);
  } finally {
    await harness.cleanup();
  }
});

test("failed writes do not advance the durable cursor marker", async () => {
  const harness = await withTempService({ batchSize: 2 });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["q1", 1],
      ["q2", 2],
      ["q3", 3],
    ]);
    let writes = 0;
    const originalBatch = db.batch.bind(db);
    db.batch = (...args) => {
      const batch = originalBatch(...args);
      const write = batch.write.bind(batch);
      batch.write = async () => {
        writes += 1;
        if (writes === 1) throw new Error("disk full");
        return write();
      };
      return batch;
    };

    await harness.service.ensureStarted();
    await assert.rejects(() => harness.service.waitUntilReady(), /disk full/);
    const status = harness.service.getStatus();
    assert.equal(status.ready, false);
    assert.equal(status.phase, "failed");
    assert.equal(status.error.message, "disk full");
    assert.equal("stack" in status.error, false);
    assert.equal(await notFound(db, META_KEY), undefined);
    assert.equal((await collectHopKeys(db)).length, 0);

    db.batch = originalBatch;
    harness.service.start();
    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();
    assert.equal(harness.service.getStatus().ready, true);
    assert.equal((await collectHopKeys(db)).length, 3);
    assert.equal((await db.get(META_KEY)).complete, true);
  } finally {
    await harness.cleanup();
  }
});

test("parent lock interleaving cannot leave stale hop keys against current a: records", async () => {
  const harness = await withTempService({ batchSize: 2, pauseMs: 0 });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["r1", 8],
      ["r2", 8],
      ["r3", 8],
      ["r4", 8],
    ]);

    let chunks = 0;
    const originalLock = harness.dbService.withWriteLock.bind(harness.dbService);
    harness.dbService.withWriteLock = (work) =>
      originalLock(work).then(async (result) => {
        chunks += 1;
        if (chunks === 1) {
          await harness.dbService.updateTaintedInfo("r1", hopRecord(1));
          await originalLock(async () => {
            const inner = await harness.dbService.init();
            const batch = inner.batch();
            batch.del("a:r2");
            batch.del(walletHopIndexKey("r2", 8));
            await batch.write();
          });
        }
        return result;
      });

    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();

    const addresses = await collectAddressRecords(db);
    const hopKeys = await collectHopKeys(db);
    const expected = new Set(
      addresses
        .filter(([, record]) => Number.isSafeInteger(record.d) && record.d >= 0)
        .map(([address, record]) => walletHopIndexKey(address, record.d))
    );
    assert.deepEqual(new Set(hopKeys.map(([key]) => key)), expected);
    assert.ok(!expected.has(walletHopIndexKey("r2", 8)));
    assert.equal(await notFound(db, walletHopIndexKey("r1", 8)), undefined);
    assert.equal(await db.get(walletHopIndexKey("r1", 1)), 1);
  } finally {
    await harness.cleanup();
  }
});

test("values stay JSON 1 for hops above 50 including MAX_SAFE_INTEGER", async () => {
  const harness = await withTempService({ batchSize: 10 });
  try {
    const db = await harness.dbService.init();
    await db.put("a:valid-high", hopRecord(51));
    await db.put("a:valid-max", hopRecord(Number.MAX_SAFE_INTEGER));
    await harness.service.ensureStarted();
    await harness.service.waitUntilReady();
    assert.equal(await db.get(walletHopIndexKey("valid-high", 51)), 1);
    assert.equal(await db.get(walletHopIndexKey("valid-max", Number.MAX_SAFE_INTEGER)), 1);
    assert.equal((await collectHopKeys(db)).length, 2);
    const marker = await db.get(META_KEY);
    assert.equal(marker.complete, true);
    assert.equal(marker.indexed, 2);
    assert.equal(marker.maxHops, Number.MAX_SAFE_INTEGER);
  } finally {
    await harness.cleanup();
  }
});

test("invalid a: hop degrees fail the build without claiming complete", async () => {
  for (const record of [
    { d: -1, p: null, t: null, n: 0, o: null },
    { d: 1.5, p: null, t: null, n: 0, o: null },
    { d: Number.MAX_SAFE_INTEGER + 1, p: null, t: null, n: 0, o: null },
  ]) {
    const harness = await withTempService({ batchSize: 10 });
    try {
      const db = await harness.dbService.init();
      await db.put("a:valid-first", hopRecord(2));
      await db.put("a:zz-invalid", record);
      await harness.service.ensureStarted();
      await assert.rejects(() => harness.service.waitUntilReady(), /invalid/i);
      const status = harness.service.getStatus();
      assert.equal(status.ready, false);
      assert.equal(status.phase, "failed");
      assert.equal(status.error && "stack" in status.error, false);
      const marker = await notFound(db, META_KEY);
      assert.notEqual(marker?.complete, true);
    } finally {
      await harness.cleanup();
    }
  }
});

test("start swallows begin failures so callers are not left with an unhandled rejection", async () => {
  const harness = await withTempService();
  try {
    harness.dbService.init = async () => {
      throw new Error("db missing");
    };
    const rejections = [];
    const onUnhandled = (reason) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      harness.service.start();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    await assert.rejects(() => harness.service.waitUntilReady(), /db missing/);
    assert.equal(harness.service.getStatus().phase, "failed");
    assert.equal(rejections.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("restart waits for a pending backfill instead of overlapping writers", async () => {
  const harness = await withTempService({ batchSize: 1, pauseMs: 0 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const db = await harness.dbService.init();
    await seedAddresses(db, [
      ["s1", 1],
      ["s2", 2],
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const originalLock = harness.dbService.withWriteLock.bind(harness.dbService);
    harness.dbService.withWriteLock = (work) =>
      originalLock(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 1) await gate;
        try {
          return await work();
        } finally {
          inFlight -= 1;
        }
      });

    const first = harness.service.ensureStarted();
    await new Promise((resolve) => {
      const poll = () => (inFlight > 0 ? resolve() : setImmediate(poll));
      poll();
    });
    harness.service.start();
    const second = harness.service.ensureStarted();
    assert.equal(first, second);
    release();
    await first;
    await harness.service.waitUntilReady();
    assert.equal(maxInFlight, 1);
    assert.equal((await collectHopKeys(db)).length, 2);
  } finally {
    release();
    await harness.cleanup();
  }
});

test("default export is a WalletIndexService singleton", () => {
  const singleton = require("../src/services/walletIndexService");
  assert.equal(singleton instanceof WalletIndexService, true);
  assert.equal(typeof singleton.ensureStarted, "function");
  assert.equal(typeof singleton.start, "function");
  assert.equal(typeof singleton.stop, "function");
  assert.equal(typeof singleton.waitUntilReady, "function");
  assert.equal(typeof singleton.getStatus, "function");
  assert.equal(typeof singleton.isReady, "function");
});

test("INDEX_BATCH_SIZE and INDEX_PAUSE_MS are bounded from the environment", () => {
  const defaults = new WalletIndexService({
    environment: {},
    dbService: {},
    logger: silentLogger,
  });
  assert.equal(defaults.batchSize, 2000);
  assert.equal(defaults.pauseMs, 100);

  const configured = new WalletIndexService({
    environment: { INDEX_BATCH_SIZE: "10000", INDEX_PAUSE_MS: "250" },
    dbService: {},
    logger: silentLogger,
  });
  assert.equal(configured.batchSize, 10000);
  assert.equal(configured.pauseMs, 250);

  const clamped = new WalletIndexService({
    environment: { INDEX_BATCH_SIZE: "9", INDEX_PAUSE_MS: "-5" },
    dbService: {},
    logger: silentLogger,
  });
  assert.equal(clamped.batchSize, 100);
  assert.equal(clamped.pauseMs, 0);

  const ceiling = new WalletIndexService({
    environment: { INDEX_BATCH_SIZE: "999999", INDEX_PAUSE_MS: "999999" },
    dbService: {},
    logger: silentLogger,
  });
  assert.equal(ceiling.batchSize, 50000);
  assert.equal(ceiling.pauseMs, 60000);
});
