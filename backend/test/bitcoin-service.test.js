const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConnectionPath,
} = require("../src/services/bitcoinService");

function notFound() {
  const error = new Error("not found");
  error.code = "LEVEL_NOT_FOUND";
  return error;
}

test("connection paths remain compatible with legacy full-path records", async () => {
  const db = { async get() { throw notFound(); } };
  const path = [{ from: "seed", to: "legacy", txHash: "legacy-tx", amount: 1 }];

  assert.deepEqual(await buildConnectionPath(db, "legacy", { path }), path);
});

test("connection paths are reconstructed from compact parent edges", async () => {
  const records = new Map([
    ["tainted:parent", {
      originalSatoshiAddress: "seed",
      degree: 1,
      parentAddress: "seed",
      edge: { from: "seed", to: "parent", txHash: "parent-tx", amount: 2 },
    }],
    ["tainted:seed", {
      originalSatoshiAddress: "seed",
      degree: 0,
      parentAddress: null,
      edge: null,
    }],
  ]);
  const db = {
    async get(key) {
      if (records.has(key)) return records.get(key);
      throw notFound();
    },
  };
  const child = {
    originalSatoshiAddress: "seed",
    degree: 2,
    parentAddress: "parent",
    edge: { from: "parent", to: "child", txHash: "child-tx", amount: 1 },
  };

  assert.deepEqual(await buildConnectionPath(db, "child", child), [
    { from: "seed", to: "parent", txHash: "parent-tx", amount: 2 },
    { from: "parent", to: "child", txHash: "child-tx", amount: 1 },
  ]);
});
