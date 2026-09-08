const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

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

test("address prefetch reads only compact wallet records", async () => {
  const requested = [];
  const db = {
    async getMany(keys) {
      requested.push(keys);
      return keys.map((key) =>
        key === "u:parent:0"
          ? { d: 1, a: "parent-address", p: "seed-address", t: "parent", n: 1, o: "seed-address" }
          : key === "a:child-address"
            ? { d: 9, p: "old", t: "old", n: 1, o: "seed-address" }
            : undefined
      );
    },
    batch() {
      return { put() {}, del() {}, async write() {} };
    },
  };
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "child",
          vin: [{ txid: "parent", vout: 0 }],
          vout: [{ value: 1, scriptPubKey: { address: "child-address" } }],
        },
      ],
    },
    db
  );

  assert.deepEqual(requested[0], ["u:parent:0"]);
  assert.deepEqual(requested[1], ["a:child-address"]);
  assert.equal(mutations.addresses[0].record.d, 2);
});

test("address witness writes never persist transaction payloads", async () => {
  const queued = [];
  const db = {
    async getMany(keys) {
      return keys.map((key) =>
        key === "u:parent:0"
          ? { d: 0, a: "seed-address", p: null, t: "parent", n: 50, o: "seed-address" }
          : undefined
      );
    },
    batch() {
      return {
        put(key, value) {
          queued.push({ key, value });
        },
        del() {},
        async write() {},
      };
    },
  };
  const service = serviceForProcessing();
  service.mainDb = db;
  service.resetBatch();

  const mutations = await service.processBlock(
    {
      tx: [
        {
          txid: "child",
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

  assert.equal(queued.length, 0);
  assert.equal(
    mutations.created.some((entry) => entry.outpoint.startsWith("tx:")),
    false
  );
  assert.deepEqual(
    mutations.addresses.map((entry) => entry.address),
    ["alice", "bob"]
  );
});
