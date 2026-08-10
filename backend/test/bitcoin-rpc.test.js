const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BITCOIN_RPC_USER ||= "test";
process.env.BITCOIN_RPC_PASS ||= "test";
const {
  BitcoinRPC,
  isTransientRpcError,
} = require("../src/services/bitcoinRPC");

test("RPC retries transient transport failures and then succeeds", async () => {
  let attempts = 0;
  const client = {
    async post() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("socket reset");
        error.code = "ECONNRESET";
        throw error;
      }
      return { data: { error: null, result: "ok" } };
    },
  };
  const rpc = new BitcoinRPC({
    user: "test",
    pass: "test",
    client,
    maxRetries: 3,
    retryDelay: 1,
  });

  assert.equal(await rpc.call("getblockhash", [1]), "ok");
  assert.equal(attempts, 3);
});

test("RPC deterministic errors are not retried", async () => {
  let attempts = 0;
  const client = {
    async post() {
      attempts += 1;
      return {
        data: {
          result: null,
          error: { code: -8, message: "Block height out of range" },
        },
      };
    },
  };
  const rpc = new BitcoinRPC({
    user: "test",
    pass: "test",
    client,
    maxRetries: 5,
    retryDelay: 1,
  });

  await assert.rejects(
    () => rpc.call("getblockhash", [-1]),
    /Block height out of range/
  );
  assert.equal(attempts, 1);
});

test("transient RPC error classification is explicit", () => {
  assert.equal(isTransientRpcError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientRpcError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientRpcError({ response: { status: 503 } }), true);
  assert.equal(isTransientRpcError({ rpcCode: -8 }), false);
});

test("block windows fetch concurrently but preserve height order", async () => {
  let active = 0;
  let maxActive = 0;
  const rpc = new BitcoinRPC({ user: "test", pass: "test", maxParallelRequests: 3 });
  rpc.call = async (method, params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const value = params[0];
    await new Promise((resolve) => setTimeout(resolve, (7 - Number(String(value).replace("hash-", ""))) * 2));
    active -= 1;
    if (method === "getblockhash") return `hash-${value}`;
    return { hash: value, tx: [] };
  };

  const blocks = await rpc.getBlocksWindow(4, 6, 3);

  assert.deepEqual(
    blocks.map((entry) => [entry.height, entry.hash]),
    [
      [4, "hash-4"],
      [5, "hash-5"],
      [6, "hash-6"],
    ]
  );
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 3);
});
