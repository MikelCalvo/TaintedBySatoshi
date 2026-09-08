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
    },
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed-address"],
  });
}

function memoryDb(records = {}) {
  const store = new Map(Object.entries(records));
  const requested = [];
  return {
    store,
    requested,
    async getMany(keys) {
      requested.push([...keys]);
      return keys.map((key) => store.get(key));
    },
    async get(key) {
      if (!store.has(key)) throw notFound();
      return store.get(key);
    },
    batch() {
      return { put() {}, del() {}, async write() {} };
    },
  };
}

test("block processing uses one multiget for unique external live outpoints", async () => {
  const db = memoryDb({
    "u:parent:0": {
      d: 2,
      a: "parent-address",
      p: "seed-address",
      t: "parent",
      n: 1,
      o: "seed-address",
    },
  });
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "child-a",
          vin: [
            { txid: "parent", vout: 0 },
            { txid: "untainted", vout: 1 },
            { txid: "parent", vout: 0 },
          ],
          vout: [{ value: 1, scriptPubKey: { address: "address-a" } }],
        },
      ],
    },
    db
  );

  assert.equal(db.requested.length, 2);
  assert.deepEqual(db.requested[0], ["u:parent:0", "u:untainted:1"]);
  assert.deepEqual(mutations.spent, ["parent:0"]);
  assert.deepEqual(
    mutations.created.map((entry) => entry.outpoint),
    ["child-a:0"]
  );
  assert.equal(mutations.created[0].record.d, 3);
  assert.equal(mutations.created[0].record.p, "parent-address");
  assert.equal(mutations.addresses[0].address, "address-a");
});

test("spent live outpoints are deleted instead of kept as history", async () => {
  const db = memoryDb({
    "u:parent:0": {
      d: 0,
      a: "seed-address",
      p: null,
      t: "parent",
      n: 50,
      o: "seed-address",
    },
  });
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "child",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [{ value: 49, scriptPubKey: { address: "child-address" } }],
        },
      ],
    },
    db
  );

  assert.deepEqual(mutations.spent, ["parent:0"]);
  assert.equal(
    mutations.created.some((entry) => entry.outpoint === "parent:0"),
    false
  );
});

test("same-block spends never persist the intermediate outpoint", async () => {
  const db = memoryDb();
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "parent",
          vin: [{ coinbase: "00" }],
          vout: [{ value: 50, scriptPubKey: { address: "seed-address" } }],
        },
        {
          txid: "child",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [{ value: 49, scriptPubKey: { address: "address-b" } }],
        },
      ],
    },
    db
  );

  assert.deepEqual(mutations.spent, []);
  assert.deepEqual(
    mutations.created.map((entry) => entry.outpoint),
    ["child:0"]
  );
  assert.equal(mutations.created[0].record.d, 1);
});

test("paying a seed does not taint sibling change", async () => {
  const db = memoryDb();
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "tribute",
          vin: [{ txid: "clean", vout: 0 }],
          vout: [
            { value: 1, scriptPubKey: { address: "seed-address" } },
            { value: 9, scriptPubKey: { address: "change-address" } },
          ],
        },
      ],
    },
    db
  );

  assert.deepEqual(
    mutations.created.map((entry) => entry.outpoint),
    ["tribute:0"]
  );
  assert.deepEqual(
    mutations.addresses.map((entry) => entry.address),
    ["seed-address"]
  );
});

test("untainted blocks skip address reads completely", async () => {
  const db = memoryDb();
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "ordinary-tx",
          vin: [{ txid: "ordinary-parent", vout: 0 }],
          vout: [{ value: 1, scriptPubKey: { address: "ordinary-address" } }],
        },
      ],
    },
    db
  );

  assert.deepEqual(mutations, {
    created: [],
    spent: [],
    addresses: [],
    newWallets: 0,
  });
  assert.deepEqual(db.requested, [["u:ordinary-parent:0"]]);
});

test("first-seen wallets count as new while hop updates do not", async () => {
  const db = memoryDb({
    "u:parent:0": {
      d: 0,
      a: "seed-address",
      p: null,
      t: "parent",
      n: 50,
      o: "seed-address",
    },
    "a:alice": {
      d: 4,
      p: "old",
      t: "old-tx",
      n: 1,
      o: "seed-address",
    },
  });
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "spread",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [
            { value: 1, scriptPubKey: { address: "alice" } },
            { value: 1, scriptPubKey: { address: "bob" } },
          ],
        },
      ],
    },
    db
  );

  assert.equal(mutations.newWallets, 1);
  assert.deepEqual(
    mutations.addresses.map((entry) => entry.address).sort(),
    ["alice", "bob"]
  );
});

test("shorter address hops replace longer ones and equal hops are skipped", async () => {
  const db = memoryDb({
    "u:parent:0": {
      d: 1,
      a: "parent-address",
      p: "seed-address",
      t: "parent",
      n: 1,
      o: "seed-address",
    },
    "a:child-address": {
      d: 4,
      p: "old",
      t: "old-tx",
      n: 1,
      o: "seed-address",
    },
  });
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "better",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [{ value: 1, scriptPubKey: { address: "child-address" } }],
        },
      ],
    },
    db
  );

  assert.equal(mutations.addresses[0].record.d, 2);
  assert.equal(mutations.addresses[0].record.p, "parent-address");
});

test("database I/O errors are not treated as untainted misses", async () => {
  const db = {
    async getMany() {
      throw new Error("NAS unavailable");
    },
    batch() {
      return { put() {}, del() {}, async write() {} };
    },
  };
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  await assert.rejects(
    () =>
      service.processBlock(
        {
          tx: [
            {
              txid: "child",
              vin: [{ txid: "parent", vout: 0 }],
              vout: [{ value: 1, scriptPubKey: { address: "address-a" } }],
            },
          ],
        },
        db
      ),
    /NAS unavailable/
  );
});
