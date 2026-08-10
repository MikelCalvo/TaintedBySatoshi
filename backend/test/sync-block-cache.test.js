const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

function createService() {
  const service = new BackgroundSyncService({
    bitcoinRPC: {},
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
  });
  service.mainDb = {
    batch() {
      return { put() {}, async write() {} };
    },
  };
  service.resetBatch();
  return service;
}

test("main prefetch reads address records separately from transaction records", async () => {
  const calls = [];
  const db = {
    async getMany(keys) {
      calls.push(keys);
      return keys.map(() => undefined);
    },
  };
  const service = createService();

  const cache = await service.prefetchMainRecords(
    db,
    ["address-a", "address-b"],
    ["tx-a", "tx-b"]
  );

  assert.deepEqual(calls, [
    ["tainted:address-a", "tainted:address-b"],
    ["tx:tx-a", "tx:tx-b"],
  ]);
  assert.equal(cache.size, 4);
});

test("block-local address and transaction caches avoid repeated NAS reads", async () => {
  let getManyCalls = 0;
  let pointGets = 0;
  const db = {
    async getMany(keys) {
      getManyCalls += 1;
      return keys.map((key) =>
        key === "tainted:existing-address" ? { degree: 1 } : undefined
      );
    },
    async get() {
      pointGets += 1;
      return undefined;
    },
    batch() {
      return { put() {}, async write() {} };
    },
  };
  const service = createService();
  service.mainDb = db;
  service.resetBatch();
  const cache = await service.prefetchMainRecords(
    db,
    ["existing-address", "new-address"],
    ["tx-a"]
  );

  await service.processAddressInBatch(
    "existing-address",
    2,
    { hash: "tx-a", time: 1, inputs: [], out: [] },
    db,
    null,
    cache
  );
  await service.processAddressInBatch(
    "new-address",
    2,
    { hash: "tx-a", time: 1, inputs: [], out: [] },
    db,
    null,
    cache
  );

  assert.equal(getManyCalls, 2);
  assert.equal(pointGets, 0);
});
