const bitcoin = require("bitcoinjs-lib");

/**
 * Validates a Bitcoin address using bitcoinjs-lib
 * Supports Legacy (1...), P2SH (3...), and Bech32 (bc1...) addresses
 */
function isValidBitcoinAddress(address) {
  if (!address || typeof address !== "string") {
    return false;
  }

  // Limit address length to prevent abuse (longest valid is ~90 chars for bech32m)
  if (address.length > 100 || address.length < 26) {
    return false;
  }

  // Check for valid characters only (alphanumeric, no ambiguous characters)
  const validCharsRegex = /^[a-zA-Z0-9]+$/;
  if (!validCharsRegex.test(address)) {
    return false;
  }

  try {
    // Handle Bech32/Bech32m addresses (starting with bc1)
    if (address.toLowerCase().startsWith("bc1")) {
      bitcoin.address.fromBech32(address);
      return true;
    }

    // For legacy addresses (starting with 1 or 3)
    if (address.startsWith("1") || address.startsWith("3")) {
      bitcoin.address.fromBase58Check(address);
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Sanitizes a string input by removing potentially dangerous characters
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "string") {
    return "";
  }

  // Remove null bytes and control characters
  return input
    .replace(/\0/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
}

/**
 * Validates and sanitizes a Bitcoin address
 * Returns the sanitized address if valid, null otherwise
 */
function validateAndSanitizeAddress(address) {
  const sanitized = sanitizeInput(address);

  if (!isValidBitcoinAddress(sanitized)) {
    return null;
  }

  return sanitized;
}

const MAX_ADDRESS_PREFIX_LENGTH = 90;
const WALLET_QUERY_CHARSET = /^[0-9A-HJ-NP-Za-z]+$/;

function invalidQuery(message = "Invalid query") {
  const error = new Error(message);
  error.code = "INVALID_QUERY";
  return error;
}

function parseBoundedAddressToken(value, { optional = false } = {}) {
  if (value == null) return null;
  if (typeof value !== "string") throw invalidQuery();
  const trimmed = value.trim();
  if (!trimmed) {
    if (optional) return null;
    throw invalidQuery();
  }
  if (trimmed.length > MAX_ADDRESS_PREFIX_LENGTH) throw invalidQuery();
  if (!WALLET_QUERY_CHARSET.test(trimmed)) throw invalidQuery();
  return trimmed;
}

function parseHopBound(value) {
  if (value == null || value === "") return null;
  if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw invalidQuery("Invalid hop bound");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalidQuery("Invalid hop bound");
  return number;
}

function walletQueryScope(query) {
  return [query.sort, query.q, query.minHops, query.maxHops];
}

function encodeWalletCursor(query, key) {
  return Buffer.from(JSON.stringify({ v: 1, scope: walletQueryScope(query), key })).toString("base64url");
}

function parseWalletListQuery(query = {}) {
  const { limit, cursor, q } = query;
  if (limit != null && typeof limit !== "string" && typeof limit !== "number") throw invalidQuery();
  const parsedLimit = Number.parseInt(limit, 10);
  const pageSize = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
  const sort = query.sort ?? "address-asc";
  if (!["address-asc", "address-desc", "hops-asc", "hops-desc"].includes(sort)) throw invalidQuery("Invalid wallet sort");
  const normalized = { limit: pageSize, q: parseBoundedAddressToken(q, { optional: true }), sort,
    minHops: parseHopBound(query.minHops), maxHops: parseHopBound(query.maxHops), cursor: null };
  if (normalized.minHops != null && normalized.maxHops != null && normalized.minHops > normalized.maxHops) throw invalidQuery("Invalid hop range");
  if (cursor != null) {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw invalidQuery("Invalid wallet cursor");
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw invalidQuery("Invalid wallet cursor"); }
    if (decoded?.v !== 1 || JSON.stringify(decoded.scope) !== JSON.stringify(walletQueryScope(normalized)) || typeof decoded.key !== "string") throw invalidQuery("Cursor does not match wallet filters");
    const key = decoded.key;
    const address = sort.startsWith("hops") ? key.slice(19) : key.slice(2);
    if (sort.startsWith("hops") ? !/^h:\d{16}:[0-9A-HJ-NP-Za-z]{1,90}$/.test(key) : !/^a:[0-9A-HJ-NP-Za-z]{1,90}$/.test(key)) throw invalidQuery("Invalid wallet cursor key");
    if (normalized.q && !address.startsWith(normalized.q)) throw invalidQuery("Invalid wallet cursor prefix");
    if (sort.startsWith("hops")) {
      const hops = Number(key.slice(2,18));
      if (!Number.isSafeInteger(hops) || hops < (normalized.minHops ?? 0) || hops > (normalized.maxHops ?? Number.MAX_SAFE_INTEGER)) throw invalidQuery("Invalid wallet cursor hops");
    }
    normalized.cursor = key;
  }
  return normalized;
}

module.exports = {
  isValidBitcoinAddress,
  sanitizeInput,
  validateAndSanitizeAddress,
  parseWalletListQuery,
  encodeWalletCursor,
  MAX_ADDRESS_PREFIX_LENGTH,
};
