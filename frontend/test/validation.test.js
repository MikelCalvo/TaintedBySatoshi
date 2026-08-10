const test = require("node:test");
const assert = require("node:assert/strict");

const { isValidBitcoinAddress } = require("../src/utils/validation");

test("accepts supported Bitcoin addresses", () => {
  assert.equal(
    isValidBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
    true
  );
  assert.equal(
    isValidBitcoinAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"),
    true
  );
  assert.equal(
    isValidBitcoinAddress("bc1qsf0hh825mv6t356fj4xlg39c5tmqa76l05zjcy"),
    true
  );
});

test("rejects malformed Bitcoin addresses", () => {
  assert.equal(isValidBitcoinAddress("not-a-bitcoin-address"), false);
  assert.equal(
    isValidBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNax"),
    false
  );
});