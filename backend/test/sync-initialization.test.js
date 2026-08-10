const test = require("node:test");
const assert = require("node:assert/strict");

const { DatabaseService } = require("../src/services/dbService");
const {
  normalizeTaintedDegree,
} = require("../src/services/syncUtils");

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

test("tainted outpoint degrees accept legacy and canonical records", () => {
  assert.equal(normalizeTaintedDegree(3), 3);
  assert.equal(normalizeTaintedDegree({ degree: 0 }), 0);
  assert.throws(
    () => normalizeTaintedDegree({ degree: "1" }),
    /invalid tainted outpoint degree/i
  );
  assert.throws(
    () => normalizeTaintedDegree(null),
    /invalid tainted outpoint degree/i
  );
});

test("coinbase initialization aborts instead of marking partial seeds ready", async () => {
  const stored = [];
  const scanDb = {
    batch() {
      return {
        put() {},
        async write() {},
      };
    },
    async put(key) {
      stored.push(key);
    },
  };
  const service = new BackgroundSyncService({
    bitcoinRPC: {
      async openDatabase() {
        return scanDb;
      },
      async call(method, params) {
        if (method === "getblockhash" && params[0] === 2) {
          throw new Error("RPC unavailable");
        }
        if (method === "getblockhash") return `hash-${params[0]}`;
        return {
          tx: [{ txid: "coinbase", vout: [{ scriptPubKey: {} }] }],
        };
      },
      getAddressFromScript() {
        return null;
      },
    },
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
    addressMetadata: { seed: { blockHeight: 2 } },
  });

  await assert.rejects(() => service.initializeCoinbaseOutputs(), /RPC unavailable/);
  assert.deepEqual(stored, []);
});

test("coinbase block heights are derived from address metadata", () => {
  const service = new BackgroundSyncService({
    bitcoinRPC: {},
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed-a", "seed-b", "seed-c"],
    addressMetadata: {
      "seed-a": { blockHeight: 4 },
      "seed-b": { blockHeight: 2 },
      "seed-c": { blockHeight: 4 },
    },
  });

  assert.deepEqual(service.getSeedBlockHeights(), [0, 1, 2, 4]);
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

test("seed initialization is awaited before the sync loop starts", async () => {
  let addressesWritten = false;
  let coinbasesWritten = false;
  const fakeMainDb = {
    async get() {
      const error = new Error("not found");
      error.code = "LEVEL_NOT_FOUND";
      throw error;
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
  const fakeScanDb = {
    async get() {
      const error = new Error("not found");
      error.code = "LEVEL_NOT_FOUND";
      throw error;
    },
  };
  let loopStarts = 0;
  const service = new BackgroundSyncService({
    bitcoinRPC: {
      async initialize() {},
      async openDatabase() {
        return fakeScanDb;
      },
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
      assert.equal(coinbasesWritten, true);
      loopStarts += 1;
    },
  });
  service.initializeCoinbaseOutputs = async () => {
    coinbasesWritten = true;
  };
  service.ensureInitialized = async function ensureInitializedForTest() {
    const db = await this.dbService.init();
    const addressBatch = db.batch();
    addressBatch.put("tainted:seed", { degree: 0 });
    await addressBatch.write();
    await this.initializeCoinbaseOutputs();
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
