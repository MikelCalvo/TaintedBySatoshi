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
      getAddressFromScript(script) {
        return script?.address || null;
      },
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

function createBatchDb({ failWrite = false } = {}) {
  const written = [];
  return {
    written,
    batch() {
      const operations = [];
      return {
        put(key, value) {
          operations.push({ type: "put", key, value });
        },
        del(key) {
          operations.push({ type: "del", key });
        },
        async write() {
          if (failWrite) throw new Error("main batch failed");
          written.push(...operations);
        },
      };
    },
  };
}

function checkpoints(db) {
  return db.written
    .filter((operation) => operation.key === "scan_progress")
    .map((operation) => operation.value);
}

test("sync commits prefetched blocks strictly in height order", async () => {
  const mainDb = createBatchDb();
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
  service.processBlock = async () => ({ created: [], spent: [], addresses: [] });

  await service.syncNewBlocks(50, 52, mainDb);

  assert.deepEqual(checkpoints(mainDb).map((entry) => entry.lastBlock), [50, 51, 52]);
});

test("a block failure stops the contiguous checkpoint", async () => {
  const mainDb = createBatchDb();
  const service = createService({ mainDb });
  service.processBlock = async (block) => {
    if (block.hash === "hash-11") throw new Error("decode failed");
    return { created: [], spent: [], addresses: [] };
  };

  await assert.rejects(
    () => service.syncNewBlocks(10, 12, mainDb),
    /decode failed/
  );

  assert.deepEqual(checkpoints(mainDb).map((entry) => entry.lastBlock), [10]);
  assert.equal(service.lastProcessedBlock, 10);
  assert.equal(service.syncStats.blocksProcessed, 1);
});

test("failed atomic main commit cannot advance the checkpoint", async () => {
  const mainDb = createBatchDb({ failWrite: true });
  const service = createService({ mainDb });
  service.processBlock = async () => ({
    created: [
      {
        outpoint: "child:0",
        record: { d: 1, a: "alice", p: "seed", t: "child", n: 1, o: "seed" },
      },
    ],
    spent: ["parent:0"],
    addresses: [{ address: "alice", record: { d: 1, p: "seed", t: "child", n: 1, o: "seed" } }],
  });

  await assert.rejects(
    () => service.syncNewBlocks(20, 20, mainDb),
    /main batch failed/
  );

  assert.deepEqual(mainDb.written, []);
  assert.equal(service.lastProcessedBlock, null);
});

test("live utxos, spent deletes, wallets and checkpoint share one commit", async () => {
  const mainDb = createBatchDb();
  const service = createService({ mainDb });
  service.processBlock = async () => ({
    created: [
      {
        outpoint: "child:0",
        record: { d: 1, a: "alice", p: "seed", t: "child", n: 1, o: "seed" },
      },
    ],
    spent: ["parent:0"],
    addresses: [{ address: "alice", record: { d: 1, p: "seed", t: "child", n: 1, o: "seed" } }],
  });

  await service.syncNewBlocks(30, 30, mainDb);

  assert.deepEqual(
    mainDb.written.map((operation) => [operation.type, operation.key]),
    [
      ["del", "u:parent:0"],
      ["put", "u:child:0"],
      ["put", "a:alice"],
      ["put", "scan_progress"],
    ]
  );
});

test("sync records stage timings and write amplification per block", async () => {
  let now = 0;
  const mainDb = createBatchDb();
  const service = new BackgroundSyncService({
    bitcoinRPC: {
      async getBlocksWindow() {
        now += 10;
        return [
          { height: 30, hash: "hash-30", block: { hash: "hash-30", tx: [] } },
        ];
      },
    },
    dbService: {
      async init() {
        return mainDb;
      },
    },
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
    now: () => now,
  });
  service.processBlock = async () => {
    now += 20;
    service.activeBlockMetrics.inputLookupMs = 4;
    service.activeBlockMetrics.addressPrefetchMs = 6;
    service.activeBlockMetrics.externalOutpoints = 8;
    service.activeBlockMetrics.addressPrefetchKeys = 12;
    service.activeBlockMetrics.taintedOutputs = 3;
    service.activeBlockMetrics.spentOutpoints = 2;
    service.activeBlockMetrics.addressWrites = 2;
    return {
      created: [
        {
          outpoint: "child:0",
          record: { d: 1, a: "alice", p: "seed", t: "child", n: 1, o: "seed" },
        },
      ],
      spent: ["parent:0"],
      addresses: [{ address: "alice", record: { d: 1, p: "seed", t: "child", n: 1, o: "seed" } }],
    };
  };
  service.flushBatch = async () => {
    now += 30;
    service.batchIsValid = false;
  };

  await service.syncNewBlocks(30, 30, mainDb);

  const last = service.getStatus().metrics.pipeline.last;
  assert.deepEqual(last, {
    height: 30,
    totalMs: 50,
    inputLookupMs: 4,
    addressPrefetchMs: 6,
    processingMs: 20,
    commitMs: 30,
    externalOutpoints: 8,
    addressPrefetchKeys: 12,
    taintedOutputs: 3,
    spentOutpoints: 2,
    addressWrites: 2,
    batchOperations: 4,
  });
  assert.deepEqual(service.getStatus().metrics.pipeline.window, {
    startBlock: 30,
    endBlock: 30,
    blocks: 1,
    prefetchMs: 10,
  });
});

test("checkpoint persists block identity and live-utxo schema version", async () => {
  const mainDb = createBatchDb();
  const service = createService({ mainDb });
  service.processBlock = async () => ({ created: [], spent: [], addresses: [] });

  await service.syncNewBlocks(30, 30, mainDb);

  const saved = checkpoints(mainDb);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    lastBlock: 30,
    blockHash: "hash-30",
    schemaVersion: 4,
    lastUpdated: saved[0].lastUpdated,
    liveOutpoints: 0,
    taintedWallets: 0,
  });
  assert.equal(typeof saved[0].lastUpdated, "number");
  assert.equal(service.lastProcessedBlock, 30);
});

test("a stored checkpoint hash mismatch stops before processing", async () => {
  const service = createService({
    mainDb: createBatchDb(),
    bitcoinRPC: {
      async call(method, params) {
        assert.equal(method, "getblockhash");
        assert.equal(params[0], 30);
        return "new-hash-30";
      },
    },
  });

  await assert.rejects(
    () =>
      service.verifyCheckpoint({
        lastBlock: 30,
        blockHash: "old-hash-30",
        schemaVersion: 4,
      }),
    /checkpoint hash mismatch/i
  );
});

test("incompatible historical schemas refuse to resume", async () => {
  const service = createService({ mainDb: createBatchDb() });

  await assert.rejects(
    () =>
      service.verifyCheckpoint({
        lastBlock: 30,
        blockHash: "hash-30",
        schemaVersion: 3,
      }),
    /incompatible database schema/i
  );
});

test("equal or worse hops are not rewritten on replay", async () => {
  const stored = new Map([
    [
      "u:parent:0",
      { d: 0, a: "seed", p: null, t: "parent", n: 50, o: "seed" },
    ],
    ["a:address-a", { d: 1, p: "seed", t: "tx-a", n: 1, o: "seed" }],
  ]);
  const mainDb = {
    async get(key) {
      if (stored.has(key)) return stored.get(key);
      throw Object.assign(new Error("not found"), { code: "LEVEL_NOT_FOUND" });
    },
    async getMany(keys) {
      return keys.map((key) => stored.get(key));
    },
    batch() {
      return {
        put() {},
        del() {},
        async write() {},
      };
    },
  };
  const service = createService({ mainDb });
  service.mainDb = mainDb;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "tx-a",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [{ value: 1, scriptPubKey: { address: "address-a" } }],
        },
      ],
    },
    mainDb
  );

  assert.deepEqual(mutations.addresses, []);
  assert.equal(mutations.created[0].outpoint, "tx-a:0");
});
