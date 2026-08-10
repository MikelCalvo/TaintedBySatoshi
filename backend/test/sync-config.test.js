const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BackgroundSyncService,
} = require("../src/services/backgroundSyncService");

const deps = {
  bitcoinRPC: {},
  dbService: {},
  logger: { info() {}, warn() {}, error() {} },
};

test("sync tuning values are clamped to safe operational ranges", () => {
  const original = {
    CHUNK_SIZE: process.env.CHUNK_SIZE,
    SYNC_PREFETCH_CONCURRENCY: process.env.SYNC_PREFETCH_CONCURRENCY,
  };
  process.env.CHUNK_SIZE = "5000";
  process.env.SYNC_PREFETCH_CONCURRENCY = "100";

  try {
    const service = new BackgroundSyncService(deps);
    assert.equal(service.config.chunkSize, 500);
    assert.equal(service.config.prefetchConcurrency, 32);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("invalid sync tuning falls back to defaults", () => {
  const original = {
    CHUNK_SIZE: process.env.CHUNK_SIZE,
    SYNC_PREFETCH_CONCURRENCY: process.env.SYNC_PREFETCH_CONCURRENCY,
  };
  process.env.CHUNK_SIZE = "not-a-number";
  process.env.SYNC_PREFETCH_CONCURRENCY = "0";

  try {
    const service = new BackgroundSyncService(deps);
    assert.equal(service.config.chunkSize, 100);
    assert.equal(service.config.prefetchConcurrency, 8);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
