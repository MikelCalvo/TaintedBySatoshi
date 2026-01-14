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

module.exports = {
  isValidBitcoinAddress,
  sanitizeInput,
  validateAndSanitizeAddress,
};
