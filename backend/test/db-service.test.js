const test = require("node:test");
const assert = require("node:assert/strict");
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
    },
  });
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
