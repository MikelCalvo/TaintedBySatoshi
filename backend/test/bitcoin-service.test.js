const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Level } = require("level");
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

function hopRecord(overrides = {}) {
  return { d: 1, p: "seed", t: "tx", n: 1, o: "seed", ...overrides };
}

function publicListedWallet(address, record = hopRecord()) {
  return {
    address,
    isConnected: true,
    isSatoshiAddress: false,
    degree: record.d,
    hops: record.d,
    origin: record.o || null,
    parent: record.p || null,
    txHash: record.t || null,
    amount: record.n || 0,
  };
}

function mockIteratorDb(records) {
  const calls = [];
  return {
    calls,
    snapshot() { return { async close() {} }; },
    iterator(options) {
      calls.push(options);
      const generator = (async function* () {
        let yielded = 0;
        for (const entry of records) {
          const [key] = entry;
          if (options.gt != null && !(key > options.gt)) continue;
          if (options.gte != null && !(key >= options.gte)) continue;
          if (options.lt != null && !(key < options.lt)) continue;
          if (options.lte != null && !(key <= options.lte)) continue;
          if (options.limit != null && yielded >= options.limit) break;
          yielded += 1;
          yield entry;
        }
      })();
      return {
        async next() { const r = await generator.next(); return r.done ? undefined : r.value; },
        async close() { await generator.return(); },
      };
    },
  };
}

test("wallet listing pages compact hop records without historical caches", async () => {
  const originalInit = dbService.init;
  const records = [
    ["a:alice", { d: 1, p: "seed", t: "tx-a", n: 1, o: "seed" }],
    ["a:bob", { d: 2, p: "alice", t: "tx-b", n: 2, o: "seed" }],
    ["u:live:0", { d: 2, a: "bob", p: "alice", t: "tx-b", n: 2, o: "seed" }],
  ];
  const db = mockIteratorDb(records);
  dbService.init = async () => db;

  try {
    const { listTaintedWallets } = require("../src/services/bitcoinService");
    assert.deepEqual(await listTaintedWallets({ limit: 10 }), {
      wallets: [
        publicListedWallet("alice", records[0][1]),
        publicListedWallet("bob", records[1][1]),
      ],
      nextCursor: null,
      hasMore: false,
      scanned: 3,
    });
    assert.equal(db.calls[0].fillCache, false);
    assert.equal(db.calls[0].limit, 11);
    assert.equal(db.calls[0].gte, "a:");
    assert.equal(db.calls[0].lt, "a;");
  } finally {
    dbService.init = originalInit;
  }
});

test("wallet listing uses one-row lookahead for a precise nextCursor", async () => {
  const originalInit = dbService.init;
  const records = [
    ["a:alice", hopRecord({ t: "tx-a" })],
    ["a:bob", hopRecord({ d: 2, p: "alice", t: "tx-b", n: 2 })],
  ];
  const db = mockIteratorDb(records);
  dbService.init = async () => db;

  try {
    const { listTaintedWallets } = require("../src/services/bitcoinService");
    assert.deepEqual(await listTaintedWallets({ limit: 2 }), {
      wallets: [
        publicListedWallet("alice", records[0][1]),
        publicListedWallet("bob", records[1][1]),
      ],
      nextCursor: null,
      hasMore: false,
      scanned: 3,
    });
    assert.equal(db.calls[0].limit, 3);
  } finally {
    dbService.init = originalInit;
  }
});

test("wallet listing seeks a:q without scanning earlier keys", async () => {
  const originalInit = dbService.init;
  const records = [
    ["a:1early", hopRecord()],
    ["a:bc1aaa", hopRecord({ t: "tx-a" })],
    ["a:bc1bbb", hopRecord({ t: "tx-b" })],
    ["a:bc1ccc", hopRecord({ t: "tx-c" })],
    ["a:zzlater", hopRecord({ t: "tx-z" })],
  ];
  const db = mockIteratorDb(records);
  dbService.init = async () => db;

  try {
    const { listTaintedWallets } = require("../src/services/bitcoinService");
    const page = await listTaintedWallets({ limit: 2, q: "bc1" });
    assert.equal(db.calls[0].fillCache, false);
    assert.equal(db.calls[0].gte, "a:bc1");
    assert.equal(db.calls[0].gt, undefined);
    assert.ok(db.calls[0].lt > "a:bc1ccc");
    assert.ok(db.calls[0].lt <= "a:bd" || db.calls[0].lt.startsWith("a:bc1"));
    assert.ok(db.calls[0].lt <= "a:zzlater");
    assert.equal(db.calls[0].limit, 3);
    assert.deepEqual(
      page.wallets.map((wallet) => wallet.address),
      ["bc1aaa", "bc1bbb"]
    );
    assert.equal(require("../src/utils/validation").parseWalletListQuery({ q: "bc1", cursor: page.nextCursor }).cursor, "a:bc1bbb");

    const nextPage = await listTaintedWallets({
      limit: 2,
      q: "bc1",
      cursor: page.nextCursor,
    });
    assert.equal(db.calls[1].gt, "a:bc1bbb");
    assert.equal(db.calls[1].gte, undefined);
    assert.equal(db.calls[1].lt, db.calls[0].lt);
    assert.deepEqual(
      nextPage.wallets.map((wallet) => wallet.address),
      ["bc1ccc"]
    );
    assert.equal(nextPage.nextCursor, null);
  } finally {
    dbService.init = originalInit;
  }
});

test("wallet listing never asks LevelDB for more than 201 reads", async () => {
  const originalInit = dbService.init;
  const db = mockIteratorDb([]);
  dbService.init = async () => db;

  try {
    const { listTaintedWallets } = require("../src/services/bitcoinService");
    await listTaintedWallets({ limit: 200, q: "bc1" });
    assert.equal(db.calls[0].limit, 201);
  } finally {
    dbService.init = originalInit;
  }
});

test("prefix search on a real LevelDB skips earlier keys and stays case-sensitive", async () => {
  const originalInit = dbService.init;
  const dir = await mkdtemp(path.join(os.tmpdir(), "tbs-wallets-"));
  const db = new Level(dir, { valueEncoding: "json" });
  await db.open();
  dbService.init = async () => db;

  try {
    for (let index = 0; index < 210; index += 1) {
      const address = `1early${String(index).padStart(4, "0")}`;
      await db.put(`a:${address}`, hopRecord({ t: `early-${index}` }));
    }
    await db.put("a:BC1hidden", hopRecord({ t: "upper" }));
    await db.put("a:bc1qmatch1", hopRecord({ t: "m1" }));
    await db.put("a:bc1qmatch2", hopRecord({ t: "m2" }));
    await db.put("a:bc1qmatch3", hopRecord({ t: "m3" }));
    await db.put("a:zzlater", hopRecord({ t: "late" }));

    const { listTaintedWallets } = require("../src/services/bitcoinService");
    const page = await listTaintedWallets({ limit: 2, q: "bc1q" });
    assert.deepEqual(
      page.wallets.map((wallet) => wallet.address),
      ["bc1qmatch1", "bc1qmatch2"]
    );
    assert.equal(require("../src/utils/validation").parseWalletListQuery({ q: "bc1q", cursor: page.nextCursor }).cursor, "a:bc1qmatch2");

    const nextPage = await listTaintedWallets({
      limit: 2,
      q: "bc1q",
      cursor: page.nextCursor,
    });
    assert.deepEqual(
      nextPage.wallets.map((wallet) => wallet.address),
      ["bc1qmatch3"]
    );
    assert.equal(nextPage.nextCursor, null);

    const exactPage = await listTaintedWallets({ limit: 3, q: "bc1q" });
    assert.equal(exactPage.wallets.length, 3);
    assert.equal(exactPage.nextCursor, null);

    const caseMismatch = await listTaintedWallets({ limit: 10, q: "BC1" });
    assert.deepEqual(
      caseMismatch.wallets.map((wallet) => wallet.address),
      ["BC1hidden"]
    );
  } finally {
    dbService.init = originalInit;
    await db.close();
    await rm(dir, { recursive: true, force: true });
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
