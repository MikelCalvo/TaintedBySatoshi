const test = require("node:test");
const assert = require("node:assert/strict");
const dbService = require("../src/services/dbService");

const {
  buildConnectionPath,
  checkAddressConnection,
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

test("compact children preserve a legacy parent's full path", async () => {
  const db = {
    async get(key) {
      assert.equal(key, "tainted:legacy-parent");
      return {
        degree: 2,
        path: [
          { from: "seed", to: "middle", txHash: "seed-tx", amount: 2 },
          {
            from: "middle",
            to: "legacy-parent",
            txHash: "legacy-tx",
            amount: 1,
          },
        ],
      };
    },
  };
  const child = {
    degree: 3,
    parentAddress: "legacy-parent",
    edge: {
      from: "legacy-parent",
      to: "child",
      txHash: "child-tx",
      amount: 0.5,
    },
  };

  assert.deepEqual(await buildConnectionPath(db, "child", child), [
    { from: "seed", to: "middle", txHash: "seed-tx", amount: 2 },
    {
      from: "middle",
      to: "legacy-parent",
      txHash: "legacy-tx",
      amount: 1,
    },
    {
      from: "legacy-parent",
      to: "child",
      txHash: "child-tx",
      amount: 0.5,
    },
  ]);
});

test("legacy parents preserve full transaction summaries for compact children", async () => {
  const originalInit = dbService.init;
  const db = {
    async get(key) {
      if (key === "tainted:child") {
        return {
          degree: 3,
          parentAddress: "legacy-parent",
          edge: {
            from: "legacy-parent",
            to: "child",
            txHash: "child-tx",
            amount: 0.5,
          },
        };
      }
      if (key === "tainted:legacy-parent") {
        return {
          degree: 2,
          path: [
            {
              from: "seed",
              to: "legacy-parent",
              txHash: "legacy-tx",
              amount: 1,
            },
          ],
        };
      }
      throw notFound();
    },
  };
  dbService.init = async () => db;

  try {
    const result = await checkAddressConnection("child");
    assert.deepEqual(result.connectionPath, [
      {
        from: "seed",
        to: "legacy-parent",
        txHash: "legacy-tx",
        amount: 1,
      },
      {
        from: "legacy-parent",
        to: "child",
        txHash: "child-tx",
        amount: 0.5,
      },
    ]);
    assert.deepEqual(result.transactions, [
      { hash: "legacy-tx", amount: 1 },
      { hash: "child-tx", amount: 0.5 },
    ]);
  } finally {
    dbService.init = originalInit;
  }
});

test("address checks derive transaction summaries from immutable path edges", async () => {
  const originalInit = dbService.init;
  const db = {
    async get(key) {
      if (key === "tainted:child") {
        return {
          degree: 2,
          parentAddress: "parent",
          edge: { from: "parent", to: "child", txHash: "child-tx", amount: 1 },
        };
      }
      if (key === "tainted:parent") {
        return {
          degree: 1,
          parentAddress: "seed",
          edge: { from: "seed", to: "parent", txHash: "parent-tx", amount: 2 },
        };
      }
      if (key.startsWith("tx:")) {
        throw new Error("checks must not read cached transaction payloads");
      }
      throw notFound();
    },
  };
  dbService.init = async () => db;

  try {
    assert.deepEqual(await checkAddressConnection("child"), {
      isConnected: true,
      isSatoshiAddress: false,
      degree: 2,
      connectionPath: [
        { from: "seed", to: "parent", txHash: "parent-tx", amount: 2 },
        { from: "parent", to: "child", txHash: "child-tx", amount: 1 },
      ],
      transactions: [
        { hash: "parent-tx", amount: 2 },
        { hash: "child-tx", amount: 1 },
      ],
    });
  } finally {
    dbService.init = originalInit;
  }
});
