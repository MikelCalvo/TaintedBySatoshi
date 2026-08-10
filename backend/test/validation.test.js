const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidBitcoinAddress,
  sanitizeInput,
  validateAndSanitizeAddress,
} = require("../src/utils/validation");

const GENESIS_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const P2SH_ADDRESS = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const BECH32_ADDRESS = "bc1qsf0hh825mv6t356fj4xlg39c5tmqa76l05zjcy";

test("accepts supported mainnet Bitcoin address formats", () => {
  assert.equal(isValidBitcoinAddress(GENESIS_ADDRESS), true);
  assert.equal(isValidBitcoinAddress(P2SH_ADDRESS), true);
  assert.equal(isValidBitcoinAddress(BECH32_ADDRESS), true);
});

test("rejects malformed and non-string Bitcoin addresses", () => {
  assert.equal(isValidBitcoinAddress("not-a-bitcoin-address"), false);
  assert.equal(isValidBitcoinAddress(`${GENESIS_ADDRESS}x`), false);
  assert.equal(isValidBitcoinAddress(null), false);
});

test("sanitizes surrounding control characters before validation", () => {
  assert.equal(sanitizeInput(` \n${GENESIS_ADDRESS}\t `), GENESIS_ADDRESS);
  assert.equal(
    validateAndSanitizeAddress(` \n${GENESIS_ADDRESS}\t `),
    GENESIS_ADDRESS
  );
});