const test = require("node:test");
const assert = require("node:assert/strict");

async function loadHelpers() {
  return import("../src/utils/syncStatus.mjs");
}

test("ETA reports warming up until throughput is measurable", async () => {
  const { getEstimatedTimeRemaining } = await loadHelpers();

  assert.equal(getEstimatedTimeRemaining(100, 0), "Warming up");
  assert.equal(getEstimatedTimeRemaining(100, null), "Warming up");
});

test("ETA formats a measured block rate into a compact duration", async () => {
  const { getEstimatedTimeRemaining } = await loadHelpers();

  assert.equal(getEstimatedTimeRemaining(3600, 1), "1h");
  assert.equal(getEstimatedTimeRemaining(90000, 1), "1d 1h");
});

test("pipeline summary exposes average timings only after samples exist", async () => {
  const { getPipelineSummary } = await loadHelpers();

  assert.equal(
    getPipelineSummary({ metrics: { pipeline: { samples: 0 } } }),
    null
  );
  assert.deepEqual(
    getPipelineSummary({
      metrics: {
        blocksPerSecond: 0.025,
        pipeline: {
          samples: 5,
          averageMs: { total: 40000, addressPrefetch: 37000, commit: 2000 },
        },
      },
    }),
    {
      throughput: 0.025,
      averageBlockSeconds: 40,
      addressPrefetchSeconds: 37,
      commitSeconds: 2,
      samples: 5,
    }
  );
});
