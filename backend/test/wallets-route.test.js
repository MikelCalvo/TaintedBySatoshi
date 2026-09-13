const test = require("node:test");
const assert = require("node:assert/strict");

const { handleListWallets } = require("../src/handlers/wallets");

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("GET /api/wallets returns 400 for malformed q and invalid cursors", async () => {
  const listed = [];
  const handler = handleListWallets({
    listTaintedWallets: async (params) => {
      listed.push(params);
      return { wallets: [], nextCursor: null };
    },
    logger: { error() {} },
  });

  const arrayRes = mockResponse();
  await handler({ query: { q: ["bc1"] } }, arrayRes);
  assert.equal(arrayRes.statusCode, 400);
  assert.match(arrayRes.body.error, /invalid/i);

  const cursorRes = mockResponse();
  await handler({ query: { q: "bc1", cursor: "1outside" } }, cursorRes);
  assert.equal(cursorRes.statusCode, 400);

  const objectRes = mockResponse();
  await handler({ query: { cursor: { address: "alice" } } }, objectRes);
  assert.equal(objectRes.statusCode, 400);

  assert.deepEqual(listed, []);
});

test("GET /api/wallets passes a scoped prefix query through to listing", async () => {
  const handler = handleListWallets({
    async listTaintedWallets(params) {
      return { wallets: [{ address: "bc1aaa" }], nextCursor: "bc1aaa", params };
    },
    logger: { error() {} },
  });

  const res = mockResponse();
  await handler({ query: { q: "  bc1  ", limit: "2", cursor: "bc1aaa" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.wallets[0].address, "bc1aaa");
  assert.equal(res.body.nextCursor, "bc1aaa");
  assert.deepEqual(res.body.params, { limit: 2, cursor: "bc1aaa", q: "bc1" });
});
