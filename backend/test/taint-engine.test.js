const test = require("node:test");
const assert = require("node:assert/strict");
const {
  processBlockTaint,
  mergeAddressRecord,
  netMutations,
  TaintStore,
} = require("../src/services/taintEngine");

function tx({
  txid,
  vin = [],
  vout = [],
  coinbase = false,
}) {
  return {
    txid,
    vin: coinbase ? [{ coinbase: "00" }] : vin,
    vout: vout.map((output) => ({
      value: output.value,
      scriptPubKey: { address: output.address },
    })),
  };
}

function block(transactions) {
  return { tx: transactions };
}

function engine(blockData, options = {}) {
  const store = options.store || new TaintStore();
  const seeds = new Set(options.seeds || ["seed-address"]);
  return processBlockTaint(blockData, {
    isSeedAddress: (address) => seeds.has(address),
    getOutpoint: (outpoint) => store.getOutpoint(outpoint),
    getAddress: (address) => store.getAddress(address),
    maxDegree: options.maxDegree ?? 0,
  });
}

test("untainted transactions produce no mutations", () => {
  const result = engine(
    block([
      tx({
        txid: "ordinary",
        vin: [{ txid: "parent", vout: 0 }],
        vout: [{ value: 1, address: "ordinary-address" }],
      }),
    ])
  );

  assert.deepEqual(result, { created: [], spent: [], addresses: [] });
});

test("seed coinbase creates a live degree-0 outpoint and wallet", () => {
  const result = engine(
    block([
      tx({
        txid: "coinbase",
        coinbase: true,
        vout: [{ value: 50, address: "seed-address" }],
      }),
    ])
  );

  assert.deepEqual(result.spent, []);
  assert.deepEqual(result.created, [
    {
      outpoint: "coinbase:0",
      record: {
        d: 0,
        a: "seed-address",
        p: null,
        t: "coinbase",
        n: 50,
        o: "seed-address",
      },
    },
  ]);
  assert.deepEqual(result.addresses, [
    {
      address: "seed-address",
      record: {
        d: 0,
        p: null,
        t: "coinbase",
        n: 50,
        o: "seed-address",
      },
    },
  ]);
});

test("spending a tainted utxo deletes it and taints every output at hop+1", () => {
  const store = new TaintStore();
  store.putOutpoint("seed-coin:0", {
    d: 0,
    a: "seed-address",
    p: null,
    t: "seed-coin",
    n: 50,
    o: "seed-address",
  });
  store.putAddress("seed-address", {
    d: 0,
    p: null,
    t: "seed-coin",
    n: 50,
    o: "seed-address",
  });

  const result = engine(
    block([
      tx({
        txid: "spread",
        vin: [{ txid: "seed-coin", vout: 0 }],
        vout: [
          { value: 30, address: "alice" },
          { value: 20, address: "bob" },
        ],
      }),
    ]),
    { store }
  );

  assert.deepEqual(result.spent, ["seed-coin:0"]);
  assert.equal(result.created.length, 2);
  assert.equal(result.created[0].record.d, 1);
  assert.equal(result.created[0].record.p, "seed-address");
  assert.equal(result.created[1].record.a, "bob");
  assert.deepEqual(
    result.addresses.map((entry) => [entry.address, entry.record.d]),
    [
      ["alice", 1],
      ["bob", 1],
    ]
  );
});

test("same-block creates that are spent never become durable utxos", () => {
  const result = netMutations(
    engine(
      block([
        tx({
          txid: "seed-tx",
          coinbase: true,
          vout: [{ value: 50, address: "seed-address" }],
        }),
        tx({
          txid: "child-tx",
          vin: [{ txid: "seed-tx", vout: 0 }],
          vout: [{ value: 49, address: "child-address" }],
        }),
      ])
    )
  );

  assert.deepEqual(result.spent, []);
  assert.deepEqual(
    result.created.map((entry) => entry.outpoint),
    ["child-tx:0"]
  );
});

test("same-block spends use newly created outpoints without looking them up", () => {
  const result = engine(
    block([
      tx({
        txid: "seed-tx",
        coinbase: true,
        vout: [{ value: 50, address: "seed-address" }],
      }),
      tx({
        txid: "child-tx",
        vin: [{ txid: "seed-tx", vout: 0 }],
        vout: [{ value: 49, address: "child-address" }],
      }),
    ])
  );

  assert.deepEqual(result.spent, ["seed-tx:0"]);
  assert.equal(result.created.length, 2);
  assert.equal(result.created[1].record.d, 1);
  assert.equal(result.created[1].record.p, "seed-address");
  assert.equal(result.created[1].record.a, "child-address");
});

test("paying a seed address does not taint sibling change outputs", () => {
  const result = engine(
    block([
      tx({
        txid: "tribute",
        vin: [{ txid: "clean-parent", vout: 1 }],
        vout: [
          { value: 1, address: "seed-address" },
          { value: 9, address: "change-address" },
        ],
      }),
    ])
  );

  assert.deepEqual(result.spent, []);
  assert.deepEqual(
    result.created.map((entry) => entry.outpoint),
    ["tribute:0"]
  );
  assert.equal(result.created[0].record.d, 0);
  assert.deepEqual(
    result.addresses.map((entry) => entry.address),
    ["seed-address"]
  );
});

test("mixed tainted inputs use the minimum hop count", () => {
  const store = new TaintStore();
  store.putOutpoint("near:0", {
    d: 2,
    a: "parent-a",
    p: "seed-address",
    t: "near",
    n: 1,
    o: "seed-address",
  });
  store.putOutpoint("far:1", {
    d: 9,
    a: "parent-b",
    p: "other",
    t: "far",
    n: 1,
    o: "seed-address",
  });

  const result = engine(
    block([
      tx({
        txid: "merge",
        vin: [
          { txid: "near", vout: 0 },
          { txid: "far", vout: 1 },
          { txid: "clean", vout: 0 },
        ],
        vout: [{ value: 2, address: "child" }],
      }),
    ]),
    { store }
  );

  assert.deepEqual(result.spent.sort(), ["far:1", "near:0"]);
  assert.equal(result.created[0].record.d, 3);
  assert.equal(result.created[0].record.p, "parent-a");
});

test("duplicate inputs are spent once", () => {
  const store = new TaintStore();
  store.putOutpoint("parent:0", {
    d: 2,
    a: "parent-address",
    p: "seed-address",
    t: "parent",
    n: 1,
    o: "seed-address",
  });

  const result = engine(
    block([
      tx({
        txid: "child",
        vin: [
          { txid: "parent", vout: 0 },
          { txid: "parent", vout: 0 },
        ],
        vout: [{ value: 1, address: "child-address" }],
      }),
    ]),
    { store }
  );

  assert.deepEqual(result.spent, ["parent:0"]);
  assert.equal(result.created.length, 1);
});

test("maxDegree stops taint from propagating further", () => {
  const store = new TaintStore();
  store.putOutpoint("edge:0", {
    d: 2,
    a: "parent-address",
    p: "seed-address",
    t: "edge",
    n: 1,
    o: "seed-address",
  });

  const result = engine(
    block([
      tx({
        txid: "too-far",
        vin: [{ txid: "edge", vout: 0 }],
        vout: [{ value: 1, address: "child-address" }],
      }),
    ]),
    { store, maxDegree: 2 }
  );

  assert.deepEqual(result.spent, ["edge:0"]);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.addresses, []);
});

test("address records keep the shortest hop and ignore later worse paths", () => {
  const existing = { d: 2, p: "near", t: "old", n: 1, o: "seed-address" };
  assert.equal(
    mergeAddressRecord(existing, { d: 5, p: "far", t: "new", n: 2, o: "seed-address" }),
    null
  );
  assert.deepEqual(
    mergeAddressRecord(existing, { d: 1, p: "closer", t: "better", n: 3, o: "seed-address" }),
    { d: 1, p: "closer", t: "better", n: 3, o: "seed-address" }
  );
  assert.deepEqual(
    mergeAddressRecord(undefined, { d: 4, p: "first", t: "tx", n: 1, o: "seed-address" }),
    { d: 4, p: "first", t: "tx", n: 1, o: "seed-address" }
  );
});

test("TaintStore applies creates, spends and shorter address hops atomically", () => {
  const store = new TaintStore();
  store.putOutpoint("old:0", {
    d: 0,
    a: "seed-address",
    p: null,
    t: "old",
    n: 50,
    o: "seed-address",
  });
  store.putAddress("alice", { d: 5, p: "far", t: "old-alice", n: 1, o: "seed-address" });

  const ops = store.applyMutations({
    created: [
      {
        outpoint: "new:0",
        record: {
          d: 1,
          a: "alice",
          p: "seed-address",
          t: "new",
          n: 49,
          o: "seed-address",
        },
      },
    ],
    spent: ["old:0"],
    addresses: [
      {
        address: "alice",
        record: { d: 1, p: "seed-address", t: "new", n: 49, o: "seed-address" },
      },
      {
        address: "bob",
        record: { d: 1, p: "seed-address", t: "new", n: 1, o: "seed-address" },
      },
    ],
  });

  assert.equal(store.getOutpoint("old:0"), undefined);
  assert.equal(store.getOutpoint("new:0").d, 1);
  assert.equal(store.getAddress("alice").d, 1);
  assert.equal(store.getAddress("bob").d, 1);
  assert.deepEqual(
    ops.map((operation) => [operation.type, operation.key]),
    [
      ["del", "u:old:0"],
      ["put", "u:new:0"],
      ["put", "a:alice"],
      ["put", "a:bob"],
    ]
  );
});

test("TaintStore rebuilds from durable live keys after restart", async () => {
  const records = new Map([
    [
      "u:live:0",
      { d: 1, a: "alice", p: "seed-address", t: "live", n: 1, o: "seed-address" },
    ],
    [
      "a:alice",
      { d: 1, p: "seed-address", t: "live", n: 1, o: "seed-address" },
    ],
    ["scan_progress", { lastBlock: 9 }],
  ]);
  const db = {
    async *iterator() {
      for (const [key, value] of records) {
        yield [key, value];
      }
    },
  };
  const store = new TaintStore();
  await store.loadFrom(db);

  assert.equal(store.getOutpoint("live:0").a, "alice");
  assert.equal(store.getAddress("alice").d, 1);
  assert.equal(store.liveOutpoints, 1);
  assert.equal(store.taintedWallets, 1);
});
