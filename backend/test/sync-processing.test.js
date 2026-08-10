const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

function notFound() {
  const error = new Error("not found");
  error.code = "LEVEL_NOT_FOUND";
  return error;
}

function serviceForProcessing() {
  return new BackgroundSyncService({
    bitcoinRPC: {
      getAddressFromScript(script) {
        return script.address || null;
      },
      formatTransaction(tx) {
        return {
          hash: tx.txid,
          time: tx.time || 0,
          inputs: [],
          out: tx.vout.map((vout) => ({
            addr: vout.scriptPubKey.address,
            value: vout.value,
          })),
        };
      },
    },
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed-address"],
  });
}

function emptyMainDb() {
  return {
    async get() {
      throw notFound();
    },
    batch() {
      return { put() {}, async write() {} };
    },
  };
}

test("block processing uses one multiget for unique external inputs", async () => {
  const requested = [];
  const scanDb = {
    async getMany(keys) {
      requested.push(keys);
      return keys.map((key) => {
        if (key === "tainted_out:parent:0") return 2;
        return undefined;
      });
    },
    async get() {
      throw new Error("point reads should not be used for block inputs");
    },
  };
  const mainDb = emptyMainDb();
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  const operations = await service.processBlock(
    {
      tx: [
        {
          txid: "child-a",
          vin: [
            { txid: "parent", vout: 0 },
            { txid: "untainted", vout: 1 },
            { txid: "parent", vout: 0 },
          ],
          vout: [
            { value: 1, scriptPubKey: { address: "address-a" } },
          ],
        },
      ],
    },
    mainDb,
    scanDb
  );

  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0], [
    "tainted_out:parent:0",
    "tainted_out:untainted:1",
  ]);
  assert.deepEqual(operations, [
    { key: "tainted_out:child-a:0", value: 3 },
  ]);
});

test("new chronological outputs are written without existence point reads", async () => {
  let getCalls = 0;
  const scanDb = {
    async getMany() {
      return [];
    },
    async get() {
      getCalls += 1;
      throw new Error("output existence read is unnecessary");
    },
  };
  const mainDb = emptyMainDb();
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  const operations = await service.processBlock(
    {
      tx: [
        {
          txid: "seed-payment",
          vin: [{ coinbase: "00" }],
          vout: [
            { value: 50, scriptPubKey: { address: "seed-address" } },
          ],
        },
      ],
    },
    mainDb,
    scanDb
  );

  assert.equal(getCalls, 0);
  assert.deepEqual(operations, [
    { key: "tainted_out:seed-payment:0", value: 0 },
  ]);
});

test("same-block spends use newly created tainted outpoints without database reads", async () => {
  const requested = [];
  const scanDb = {
    async getMany(keys) {
      requested.push(keys);
      return [];
    },
  };
  const mainDb = emptyMainDb();
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  const operations = await service.processBlock(
    {
      tx: [
        {
          txid: "parent",
          vin: [{ coinbase: "00" }],
          vout: [
            { value: 50, scriptPubKey: { address: "seed-address" } },
          ],
        },
        {
          txid: "child",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [
            { value: 49, scriptPubKey: { address: "address-b" } },
          ],
        },
      ],
    },
    mainDb,
    scanDb
  );

  assert.deepEqual(requested, []);
  assert.deepEqual(operations, [
    { key: "tainted_out:parent:0", value: 0 },
    { key: "tainted_out:child:0", value: 1 },
  ]);
});

test("undefined values from LevelDB get are treated as missing", async () => {
  const queued = [];
  const mainDb = {
    async get() {
      return undefined;
    },
    batch() {
      return {
        put(key, value) {
          queued.push({ key, value });
        },
        async write() {},
      };
    },
  };
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  await service.processAddressInBatch(
    "address-a",
    1,
    { hash: "tx-a", time: 1, inputs: [], out: [{ addr: "address-a", value: 1 }] },
    mainDb
  );

  assert.deepEqual(queued.map((entry) => entry.key), ["tx:tx-a", "tainted:address-a"]);
});

test("new taint records store one parent edge instead of copying full paths", async () => {
  const queued = [];
  const mainDb = {
    async get(key) {
      if (key === "tainted:parent-address") {
        return {
          originalSatoshiAddress: "seed-address",
          degree: 2,
          path: [{ from: "seed-address", to: "parent-address" }],
        };
      }
      return undefined;
    },
    batch() {
      return {
        put(key, value) {
          queued.push({ key, value });
        },
        async write() {},
      };
    },
  };
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  await service.processAddressInBatch(
    "child-address",
    3,
    {
      hash: "child-tx",
      time: 1,
      inputs: [],
      out: [{ addr: "child-address", value: 1 }],
    },
    mainDb,
    "parent-address"
  );

  const child = queued.find((entry) => entry.key === "tainted:child-address").value;
  assert.equal(child.originalSatoshiAddress, "seed-address");
  assert.equal(child.parentAddress, "parent-address");
  assert.deepEqual(child.edge, {
    from: "parent-address",
    to: "child-address",
    txHash: "child-tx",
    amount: 1,
  });
  assert.equal(child.path, undefined);
});

test("database I/O errors are not treated as untainted misses", async () => {
  const scanDb = {
    async getMany() {
      throw new Error("NAS unavailable");
    },
  };
  const mainDb = emptyMainDb();
  const service = serviceForProcessing();
  service.mainDb = mainDb;
  service.resetBatch();

  await assert.rejects(
    () =>
      service.processBlock(
        {
          tx: [
            {
              txid: "child",
              vin: [{ txid: "parent", vout: 0 }],
              vout: [
                { value: 1, scriptPubKey: { address: "address-a" } },
              ],
            },
          ],
        },
        mainDb,
        scanDb
      ),
    /NAS unavailable/
  );
});
