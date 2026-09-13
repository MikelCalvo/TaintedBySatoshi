const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { mkdtemp, rm } = require("fs/promises");
const { DatabaseService } = require("../src/services/dbService");

function createHarness(environment = {}) {
  let capturedPath;
  let capturedOptions;
  const database = {
    status: "closed",
    async open() {
      this.status = "open";
    },
    async close() {
      this.status = "closed";
    },
  };
  const service = new DatabaseService({
    environment,
    dbPath: "/tmp/test-leveldb",
    createDatabase(dbPath, options) {
      capturedPath = dbPath;
      capturedOptions = options;
      return database;
    },
    ensureDirectory() {},
    logger: { info() {} },
  });
  return {
    service,
    getCaptured: () => ({ path: capturedPath, options: capturedOptions }),
  };
}

test("LevelDB uses a larger bounded read cache for NAS workloads", async () => {
  const { service, getCaptured } = createHarness({
    LEVELDB_CACHE_MB: "256",
  });

  await service.init();

  assert.deepEqual(getCaptured(), {
    path: "/tmp/test-leveldb",
    options: {
      valueEncoding: "json",
      createIfMissing: true,
      cacheSize: 256 * 1024 * 1024,
      blockSize: 32 * 1024,
    },
  });
  assert.equal(getCaptured().options.writeBufferSize, undefined);
  assert.equal(getCaptured().options.maxFileSize, undefined);
});

test("LevelDB cache configuration falls back and clamps unsafe values", async () => {
  for (const [configured, expectedMb] of [
    [undefined, 128],
    ["invalid", 128],
    ["1", 16],
    ["2048", 512],
  ]) {
    const environment = {};
    if (configured !== undefined) environment.LEVELDB_CACHE_MB = configured;
    const { service, getCaptured } = createHarness(environment);

    await service.init();

    assert.equal(getCaptured().options.cacheSize, expectedMb * 1024 * 1024);
  }
});

test("LevelDB uses a 32KiB table block size by default", async () => {
  const { service, getCaptured } = createHarness({
    LEVELDB_BLOCK_KB: "32",
  });

  await service.init();

  assert.equal(getCaptured().options.blockSize, 32 * 1024);
  assert.equal(getCaptured().options.cacheSize, 128 * 1024 * 1024);
  assert.equal(getCaptured().options.writeBufferSize, undefined);
  assert.equal(getCaptured().options.maxFileSize, undefined);
});

test("LevelDB block size configuration falls back and clamps unsafe values", async () => {
  for (const [configured, expectedKb] of [
    [undefined, 32],
    ["invalid", 32],
    ["", 32],
    [true, 32],
    ["32garbage", 32],
    ["16.5", 32],
    ["32.5", 32],
    ["1", 4],
    ["2048", 64],
    ["4", 4],
    ["64", 64],
  ]) {
    const environment = {};
    if (configured !== undefined) environment.LEVELDB_BLOCK_KB = configured;
    const { service, getCaptured } = createHarness(environment);

    await service.init();

    assert.equal(getCaptured().options.blockSize, expectedKb * 1024);
    assert.equal(getCaptured().options.cacheSize, 128 * 1024 * 1024);
    assert.equal(getCaptured().options.writeBufferSize, undefined);
    assert.equal(getCaptured().options.maxFileSize, undefined);
  }
});

test("reopening a 4KiB LevelDB with 32KiB blocks preserves schema-4 records and spends", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tbs-block-"));
  let writer;
  let reader;
  const wallet = { d: 1, p: "seed", t: "txid", n: 0, o: "seed" };
  const liveUtxo = { d: 1, a: "addr1", p: "seed", t: "txid", n: 0, o: 1 };
  const spentUtxo = { d: 2, a: "addr2", p: "addr1", t: "spenttx", n: 1, o: 0 };
  const checkpoint = {
    lastBlock: 123456,
    blockHash: "00".repeat(32),
    schemaVersion: 4,
    taintedWallets: 2,
  };

  try {
    writer = new DatabaseService({
      dbPath: dir,
      environment: { LEVELDB_BLOCK_KB: "4", LEVELDB_CACHE_MB: "16" },
      logger: { info() {} },
    });
    await writer.init();
    await writer.db.put("a:addr1", wallet);
    await writer.db.put("u:txid:0", liveUtxo);
    await writer.db.put("u:spenttx:1", spentUtxo);
    await writer.db.del("u:spenttx:1");
    await writer.db.put("scan_progress", checkpoint);
    await writer.db.batch(Array.from({ length: 2000 }, (_, i) => ({
      type: "put", key: `a:fixture${String(i).padStart(5, "0")}`, value: wallet,
    })));
    // Create real old-format SST blocks, not just a tiny WAL replay.
    await writer.db.compactRange("a:", "v:");
    assert.ok(Number(await writer.db.approximateSize("a:", "v:")) > 4096);
    await writer.close();

    reader = new DatabaseService({
      dbPath: dir,
      environment: { LEVELDB_BLOCK_KB: "32", LEVELDB_CACHE_MB: "16" },
      logger: { info() {} },
    });
    await reader.init();

    assert.deepEqual(await reader.getTaintedInfo("addr1"), wallet);
    assert.deepEqual(await reader.getLiveOutpoint("txid:0"), liveUtxo);
    assert.equal(await reader.getLiveOutpoint("spenttx:1") ?? null, null);
    assert.deepEqual(await reader.db.get("scan_progress"), checkpoint);
    assert.equal((await reader.db.get("scan_progress")).schemaVersion, 4);
    assert.equal(reader.databaseOptions.blockSize, 32 * 1024);
    await reader.close();
  } finally {
    await reader?.close();
    await writer?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
