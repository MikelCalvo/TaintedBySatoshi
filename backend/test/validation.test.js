const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidBitcoinAddress,
  sanitizeInput,
  validateAndSanitizeAddress,
  parseWalletListQuery,
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

function assertInvalidWalletQuery(query) {
  assert.throws(() => parseWalletListQuery(query), (error) => {
    assert.equal(error.code, "INVALID_QUERY");
    assert.match(error.message, /invalid/i);
    return true;
  });
}

test("wallet list query defaults preserve lexical address paging", () => {
  assert.deepEqual(parseWalletListQuery({}), {
    limit: 50,
    cursor: null,
    q: null,
  });
  assert.deepEqual(parseWalletListQuery({ limit: "10" }), {
    limit: 10,
    cursor: null,
    q: null,
  });
});

test("wallet list query trims a case-sensitive address prefix and allows 0", () => {
  assert.deepEqual(parseWalletListQuery({ q: "  bc10q  " }), {
    limit: 50,
    cursor: null,
    q: "bc10q",
  });
  assert.equal(parseWalletListQuery({ q: "  \t  " }).q, null);
});

test("wallet list query rejects malformed q, cursor, and limit values", () => {
  assertInvalidWalletQuery({ q: ["bc1"] });
  assertInvalidWalletQuery({ q: { prefix: "bc1" } });
  assertInvalidWalletQuery({ q: "bc1-invalid" });
  assertInvalidWalletQuery({ q: "I" });
  assertInvalidWalletQuery({ q: "O" });
  assert.equal(parseWalletListQuery({ q: "i0ol" }).q, "i0ol");
  assert.equal(parseWalletListQuery({ q: "bc1l0" }).q, "bc1l0");
  assert.equal(parseWalletListQuery({ q: "a".repeat(90) }).q, "a".repeat(90));
  assertInvalidWalletQuery({ q: "a".repeat(91) });
  assertInvalidWalletQuery({ cursor: ["alice"] });
  assertInvalidWalletQuery({ cursor: { address: "alice" } });
  assertInvalidWalletQuery({ cursor: "" });
  assertInvalidWalletQuery({ cursor: "bc1/../escape" });
  assertInvalidWalletQuery({ limit: ["10"] });
  assertInvalidWalletQuery({ limit: { n: 10 } });
});

test("wallet list query scopes cursors to the requested prefix", () => {
  assert.deepEqual(
    parseWalletListQuery({ q: "bc1", cursor: "bc1qsf0hh825mv6t356fj4xlg39c5tmqa76l05zjcy" }),
    {
      limit: 50,
      cursor: "bc1qsf0hh825mv6t356fj4xlg39c5tmqa76l05zjcy",
      q: "bc1",
    }
  );
  assertInvalidWalletQuery({ q: "bc1", cursor: GENESIS_ADDRESS });
  assertInvalidWalletQuery({ q: "bc1", cursor: "BC1outside" });
});

test("wallet list query clamps limit between 1 and 200", () => {
  assert.equal(parseWalletListQuery({ limit: "0" }).limit, 1);
  assert.equal(parseWalletListQuery({ limit: "201" }).limit, 200);
  assert.equal(parseWalletListQuery({ limit: "abc" }).limit, 50);
});