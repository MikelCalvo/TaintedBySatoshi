const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseService } = require("../src/services/dbService");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

test("database initialization is single-flight", async () => {
  let opens = 0;
  let releaseOpen;
  const openGate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  const fakeDb = {
    status: "closed",
    async open() {
      opens += 1;
      await openGate;
      this.status = "open";
    },
  };
  const service = new DatabaseService({
    dbPath: "/unused",
    createDatabase: () => fakeDb,
    ensureDirectory: () => {},
    logger: { info() {} },
  });

  const first = service.init();
  const second = service.init();

  assert.equal(opens, 1);
  releaseOpen();
  assert.equal(await first, fakeDb);
  assert.equal(await second, fakeDb);
  assert.equal(opens, 1);
});

test("seed wallet initialization aborts instead of marking partial seeds ready", async () => {
  const stored = [];
  const db = {
    async get() {
      throw Object.assign(new Error("not found"), { code: "LEVEL_NOT_FOUND" });
    },
    batch() {
      return {
        put(key, value) {
          stored.push({ key, value });
          if (key === "a:seed-b") throw new Error("NAS unavailable");
        },
        async write() {},
      };
    },
  };
  const service = new BackgroundSyncService({
    bitcoinRPC: { async initialize() {} },
    dbService: {
      async init() {
        return db;
      },
    },
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed-a", "seed-b"],
  });

  await assert.rejects(() => service.initializeSeedWallets(), /NAS unavailable/);
  assert.equal(
    stored.some((entry) => entry.key === "scan_progress"),
    false
  );
});

test("sync loop cannot start before initialization finishes", async () => {
  let releaseInitialization;
  const initializationGate = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  let initializationCalls = 0;
  let loopStarts = 0;

  const service = new BackgroundSyncService({
    bitcoinRPC: {
      async initialize() {},
    },
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
    ensureInitialized: async () => {
      initializationCalls += 1;
      await initializationGate;
    },
    startSyncLoop: () => {
      loopStarts += 1;
    },
  });

  const starting = service.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(initializationCalls, 1);
  assert.equal(loopStarts, 0);

  releaseInitialization();
  await starting;

  assert.equal(initializationCalls, 1);
  assert.equal(loopStarts, 1);
  assert.equal(service.dbReady, true);
});

test("seed wallets are awaited before the sync loop starts", async () => {
  let addressesWritten = false;
  const fakeMainDb = {
    async get() {
      throw Object.assign(new Error("not found"), { code: "LEVEL_NOT_FOUND" });
    },
    batch() {
      return {
        put() {},
        async write() {
          addressesWritten = true;
        },
      };
    },
  };
  let loopStarts = 0;
  const service = new BackgroundSyncService({
    bitcoinRPC: {
      async initialize() {},
    },
    dbService: {
      async init() {
        return fakeMainDb;
      },
    },
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
    startSyncLoop: () => {
      assert.equal(addressesWritten, true);
      loopStarts += 1;
    },
  });
  service.ensureInitialized = async function ensureInitializedForTest() {
    const db = await this.dbService.init();
    const addressBatch = db.batch();
    addressBatch.put("a:seed", { d: 0, p: null, t: null, n: 0, o: "seed" });
    await addressBatch.write();
  };

  await service.start();
  assert.equal(loopStarts, 1);
});

test("concurrent starts share the same initialization", async () => {
  let releaseInitialization;
  const initializationGate = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  let initializationCalls = 0;
  let loopStarts = 0;

  const service = new BackgroundSyncService({
    bitcoinRPC: { async initialize() {} },
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
    ensureInitialized: async () => {
      initializationCalls += 1;
      await initializationGate;
    },
    startSyncLoop: () => {
      loopStarts += 1;
    },
  });

  const first = service.start();
  const second = service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializationCalls, 1);

  releaseInitialization();
  await Promise.all([first, second]);
  assert.equal(loopStarts, 1);
});
