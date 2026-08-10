const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

function createService(overrides = {}) {
  return new BackgroundSyncService({
    bitcoinRPC: {
      async initialize() {},
      async call(method, params) {
        if (method === "getblockhash") return `hash-${params[0]}`;
        if (method === "getblock") return { hash: params[0], tx: [] };
        throw new Error(`Unexpected method ${method}`);
      },
      ...overrides.bitcoinRPC,
    },
    dbService: {
      async init() {
        return overrides.mainDb;
      },
    },
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
  });
}

function createBatchDb({ failWrite = false, order = [] } = {}) {
  const written = [];
  return {
    written,
    batch() {
      const operations = [];
      return {
        put(key, value) {
          operations.push({ type: "put", key, value });
        },
        async write() {
          order.push("main");
          if (failWrite) throw new Error("main batch failed");
          written.push(...operations);
        },
      };
    },
  };
}

function createScanDb({ failWrite = false, order = [] } = {}) {
  const written = [];
  return {
    written,
    batch() {
      const operations = [];
      return {
        put(key, value) {
          operations.push({ type: "put", key, value });
        },
        async write() {
          order.push("scan");
          if (failWrite) throw new Error("scan batch failed");
          written.push(...operations);
        },
      };
    },
  };
}

function checkpoints(scanDb) {
  return scanDb.written
    .filter((operation) => operation.key === "scan_progress")
    .map((operation) => operation.value);
}

test("sync commits prefetched blocks strictly in height order", async () => {
  const mainDb = createBatchDb();
  const scanDb = createScanDb();
  const service = createService({
    mainDb,
    bitcoinRPC: {
      async getBlocksWindow() {
        return [
          { height: 50, hash: "hash-50", block: { hash: "hash-50", tx: [] } },
          { height: 51, hash: "hash-51", block: { hash: "hash-51", tx: [] } },
          { height: 52, hash: "hash-52", block: { hash: "hash-52", tx: [] } },
        ];
      },
    },
  });
  service.processBlock = async () => [];

  await service.syncNewBlocks(50, 52, scanDb);

  assert.deepEqual(checkpoints(scanDb).map((entry) => entry.lastBlock), [50, 51, 52]);
});

test("a block failure stops the contiguous checkpoint", async () => {
  const mainDb = createBatchDb();
  const scanDb = createScanDb();
  const service = createService({ mainDb });
  service.processBlock = async (block) => {
    if (block.hash === "hash-11") throw new Error("decode failed");
    return [];
  };

  await assert.rejects(
    () => service.syncNewBlocks(10, 12, scanDb),
    /decode failed/
  );

  assert.deepEqual(checkpoints(scanDb).map((entry) => entry.lastBlock), [10]);
  assert.equal(service.lastProcessedBlock, 10);
  assert.equal(service.syncStats.blocksProcessed, 1);
});

test("checkpoint is written only after the main database batch is durable", async () => {
  const order = [];
  const mainDb = createBatchDb({ failWrite: true, order });
  const scanDb = createScanDb({ order });
  const service = createService({ mainDb });
  service.processBlock = async () => {
    service.safeBatchPut("tainted:test", { degree: 1 });
    return [{ key: "tainted_out:test:0", value: 1 }];
  };

  await assert.rejects(
    () => service.syncNewBlocks(20, 20, scanDb),
    /main batch failed/
  );

  assert.deepEqual(order, ["main"]);
  assert.deepEqual(checkpoints(scanDb), []);
  assert.equal(service.lastProcessedBlock, null);
});

test("scan state and checkpoint commit together after main data", async () => {
  const order = [];
  const mainDb = createBatchDb({ order });
  const scanDb = createScanDb({ order });
  const service = createService({ mainDb });
  service.processBlock = async () => {
    service.safeBatchPut("tainted:test", { degree: 1 });
    return [{ key: "tainted_out:test:0", value: 1 }];
  };

  await service.syncNewBlocks(30, 30, scanDb);

  assert.deepEqual(order, ["main", "scan"]);
  assert.deepEqual(
    scanDb.written.map((operation) => operation.key),
    ["tainted_out:test:0", "scan_progress"]
  );
  assert.equal(mainDb.written[0].key, "tainted:test");
});

test("checkpoint persists block identity and schema version", async () => {
  const mainDb = createBatchDb();
  const scanDb = createScanDb();
  const service = createService({ mainDb });
  service.processBlock = async () => [];

  await service.syncNewBlocks(30, 30, scanDb);

  const saved = checkpoints(scanDb);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    lastBlock: 30,
    blockHash: "hash-30",
    schemaVersion: 2,
    lastUpdated: saved[0].lastUpdated,
  });
  assert.equal(typeof saved[0].lastUpdated, "number");
  assert.equal(service.lastProcessedBlock, 30);
});


test("replaying a block after scan commit failure does not overwrite a shorter path", async () => {
  const stored = new Map([
    ["tainted:address-a", { degree: 1 }],
    ["tx:tx-a", { hash: "tx-a" }],
  ]);
  const mainDb = {
    async get(key) {
      if (stored.has(key)) return stored.get(key);
      const error = new Error("not found");
      error.code = "LEVEL_NOT_FOUND";
      throw error;
    },
    batch() {
      return {
        put() {
          throw new Error("replay should not enqueue writes");
        },
        async write() {},
      };
    },
  };
  const service = createService({ mainDb });
  service.mainDb = mainDb;
  service.resetBatch();

  await service.processAddressInBatch(
    "address-a",
    1,
    { hash: "tx-a", time: 1, inputs: [], out: [] },
    mainDb
  );

  assert.equal(service.batchCount, 0);
});

test("a scan commit failure leaves the checkpoint unchanged for replay", async () => {
  const mainDb = createBatchDb();
  const scanDb = createScanDb({ failWrite: true });
  const service = createService({ mainDb });
  service.processBlock = async () => {
    service.safeBatchPut("tainted:test", { degree: 1 });
    return [{ key: "tainted_out:test:0", value: 1 }];
  };

  await assert.rejects(
    () => service.syncNewBlocks(40, 40, scanDb),
    /scan batch failed/
  );

  assert.deepEqual(checkpoints(scanDb), []);
  assert.equal(service.lastProcessedBlock, null);
});
