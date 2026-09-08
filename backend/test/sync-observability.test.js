const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

function service() {
  return new BackgroundSyncService({
    bitcoinRPC: {},
    dbService: {},
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
  });
}

test("sync status distinguishes initialization, ready and failed states", () => {
  const sync = service();
  assert.equal(sync.getStatus().phase, "stopped");
  assert.equal(sync.isReady(), false);

  sync.isRunning = true;
  sync.phase = "initializing";
  assert.equal(sync.getStatus().phase, "initializing");
  assert.equal(sync.isReady(), false);

  sync.dbReady = true;
  sync.phase = "ready";
  assert.equal(sync.isReady(), true);

  sync.phase = "syncing";
  sync.currentHeight = 100;
  sync.lastProcessedBlock = 99;
  assert.equal(sync.isReady(), true);

  sync.lastProcessedBlock = 90;
  assert.equal(sync.isReady(), false);

  sync.lastError = { message: "NAS unavailable", height: 12 };
  sync.phase = "retrying";
  assert.deepEqual(sync.getStatus().lastError, {
    message: "NAS unavailable",
    height: 12,
  });
  assert.equal(sync.isReady(), false);
});

test("committed blocks update durable checkpoint throughput metrics", () => {
  const sync = service();
  sync.currentHeight = 100;
  sync.recordCommittedBlock(90, "hash-90", 1000);
  sync.recordCommittedBlock(91, "hash-91", 2000);

  const status = sync.getStatus();
  assert.equal(status.durableCheckpoint.height, 91);
  assert.equal(status.durableCheckpoint.hash, "hash-91");
  assert.equal(status.blocksBehind, 9);
  assert.equal(status.metrics.blocksPerSecond, 1);
});

test("block stage metrics expose timings, I/O volume and slow-block context", () => {
  const sync = service();
  sync.recordBlockMetrics({
    height: 90,
    totalMs: 1200,
    inputLookupMs: 100,
    addressPrefetchMs: 300,
    processingMs: 500,
    commitMs: 300,
    externalOutpoints: 40,
    addressPrefetchKeys: 80,
    taintedOutputs: 12,
    spentOutpoints: 7,
    addressWrites: 9,
    batchOperations: 27,
  });
  sync.recordBlockMetrics({
    height: 91,
    totalMs: 2400,
    inputLookupMs: 200,
    addressPrefetchMs: 700,
    processingMs: 900,
    commitMs: 600,
    externalOutpoints: 50,
    addressPrefetchKeys: 100,
    taintedOutputs: 20,
    spentOutpoints: 11,
    addressWrites: 14,
    batchOperations: 43,
  });

  const pipeline = sync.getStatus().metrics.pipeline;
  assert.equal(pipeline.samples, 2);
  assert.deepEqual(pipeline.averageMs, {
    total: 1800,
    inputLookup: 150,
    addressPrefetch: 500,
    processing: 700,
    commit: 450,
  });
  assert.equal(pipeline.last.height, 91);
  assert.equal(pipeline.last.addressWrites, 14);
  assert.equal(pipeline.slowest.height, 91);
  assert.equal(pipeline.slowest.totalMs, 2400);
});

test("status reports live utxo and tainted wallet counts", () => {
  const sync = service();
  sync.taintStats = { liveOutpoints: 12, taintedWallets: 8, byDegree: { 1: 8 } };
  const status = sync.getStatus();
  assert.equal(status.stats.liveOutpoints, 12);
  assert.equal(status.stats.taintedWallets, 8);
});

test("stop waits for an active sync and closes the shared database", async () => {
  let finishSync;
  const active = new Promise((resolve) => {
    finishSync = resolve;
  });
  let mainClosed = false;
  const sync = new BackgroundSyncService({
    bitcoinRPC: {},
    dbService: {
      async close() {
        mainClosed = true;
      },
    },
    logger: { info() {}, error() {} },
    satoshiAddresses: ["seed"],
  });
  sync.isRunning = true;
  sync.activeSync = active;

  let stopped = false;
  const stopping = sync.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  finishSync();
  await stopping;
  assert.equal(mainClosed, true);
  assert.equal(sync.phase, "stopped");
});
