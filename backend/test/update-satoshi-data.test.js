const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";

const {
  processAddress,
} = require("../src/scripts/updateSatoshiData");

function notFound() {
  const error = new Error("not found");
  error.code = "LEVEL_NOT_FOUND";
  return error;
}

const transaction = {
  hash: "tx-a",
  time: 1,
  inputs: [],
  out: [{ addr: "address-a", value: 1 }],
};

test("legacy rebuild batches omit redundant transaction payloads", async () => {
  const operations = [];
  const db = {
    async get(key) {
      assert.equal(key, "tainted:address-a");
      throw notFound();
    },
  };
  const batchContext = {
    batch: {
      put(key, value) {
        operations.push({ key, value });
      },
      async write() {},
    },
    count: 0,
    lastFlush: Date.now(),
  };

  await processAddress("address-a", 1, db, transaction, null, batchContext);

  assert.deepEqual(operations.map((operation) => operation.key), [
    "tainted:address-a",
  ]);
  assert.deepEqual(operations[0].value, {
    txHash: "tx-a",
    originalSatoshiAddress: "address-a",
    amount: 1,
    degree: 1,
    path: [],
    lastUpdated: operations[0].value.lastUpdated,
  });
});

test("legacy rebuild fallback omits redundant transaction payloads", async () => {
  const puts = [];
  const db = {
    async get(key) {
      assert.equal(key, "tainted:address-a");
      throw notFound();
    },
    async put(key, value) {
      puts.push({ key, value });
    },
  };

  await processAddress("address-a", 1, db, transaction);

  assert.deepEqual(puts.map((put) => put.key), ["tainted:address-a"]);
  assert.deepEqual(puts[0].value, {
    txHash: "tx-a",
    originalSatoshiAddress: "address-a",
    amount: 1,
    degree: 1,
    path: [],
    lastUpdated: puts[0].value.lastUpdated,
  });
});
