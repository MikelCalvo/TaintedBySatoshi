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

test("connection paths are reconstructed from compact parent hops", async () => {
  const records = new Map([
    ["a:parent", { d: 1, p: "seed", t: "parent-tx", n: 2, o: "seed" }],
    ["a:seed", { d: 0, p: null, t: null, n: 0, o: "seed" }],
  ]);
  const db = {
    async get(key) {
      if (records.has(key)) return records.get(key);
      throw notFound();
    },
  };
  const child = { d: 2, p: "parent", t: "child-tx", n: 1, o: "seed" };

  assert.deepEqual(await buildConnectionPath(db, "child", child), [
    { from: "seed", to: "parent", txHash: "parent-tx", amount: 2, hops: 1 },
    { from: "parent", to: "child", txHash: "child-tx", amount: 1, hops: 2 },
  ]);
});

test("address checks report hops without reading transaction caches", async () => {
  const originalInit = dbService.init;
  const db = {
    async get(key) {
      if (key === "a:child") {
        return { d: 2, p: "parent", t: "child-tx", n: 1, o: "seed" };
      }
      if (key === "a:parent") {
        return { d: 1, p: "seed", t: "parent-tx", n: 2, o: "seed" };
      }
      if (key === "a:seed") {
        return { d: 0, p: null, t: null, n: 0, o: "seed" };
      }
      if (key.startsWith("tx:") || key.startsWith("tainted:")) {
        throw new Error("checks must not read historical caches");
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
      hops: 2,
      origin: "seed",
      connectionPath: [
        { from: "seed", to: "parent", txHash: "parent-tx", amount: 2, hops: 1 },
        { from: "parent", to: "child", txHash: "child-tx", amount: 1, hops: 2 },
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

test("wallet listing pages compact hop records without historical caches", async () => {
  const originalInit = dbService.init;
  const records = [
    ["a:alice", { d: 1, p: "seed", t: "tx-a", n: 1, o: "seed" }],
    ["a:bob", { d: 2, p: "alice", t: "tx-b", n: 2, o: "seed" }],
    ["u:live:0", { d: 2, a: "bob", p: "alice", t: "tx-b", n: 2, o: "seed" }],
  ];
  dbService.init = async () => ({
    iterator() {
      return (async function* () {
        for (const entry of records) yield entry;
      })();
    },
  });

  try {
    const { listTaintedWallets } = require("../src/services/bitcoinService");
    assert.deepEqual(await listTaintedWallets({ limit: 10 }), {
      wallets: [
        {
          address: "alice",
          isConnected: true,
          isSatoshiAddress: false,
          degree: 1,
          hops: 1,
          origin: "seed",
          parent: "seed",
          txHash: "tx-a",
          amount: 1,
        },
        {
          address: "bob",
          isConnected: true,
          isSatoshiAddress: false,
          degree: 2,
          hops: 2,
          origin: "seed",
          parent: "alice",
          txHash: "tx-b",
          amount: 2,
        },
      ],
      nextCursor: null,
    });
  } finally {
    dbService.init = originalInit;
  }
});

test("unknown addresses are reported as unconnected", async () => {
  const originalInit = dbService.init;
  dbService.init = async () => ({
    async get() {
      throw notFound();
    },
  });

  try {
    assert.deepEqual(await checkAddressConnection("1UnknownAddressxxxxxxxxxxxxxx"), {
      isConnected: false,
      isSatoshiAddress: false,
      degree: 0,
      hops: 0,
      origin: null,
      connectionPath: [],
      transactions: [],
    });
  } finally {
    dbService.init = originalInit;
  }
});
