const test = require("node:test");
const assert = require("node:assert/strict");

const {
  updateSatoshiTransactions,
} = require("../src/scripts/updateSatoshiData");

test("legacy rebuild entrypoint no longer scans or writes taint records", async () => {
  assert.equal(typeof updateSatoshiTransactions, "function");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      require("../src/scripts/updateSatoshiData"),
      "processAddress"
    ),
    false
  );
});
