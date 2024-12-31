const bitcoin = require("bitcoinjs-lib");

function isValidBitcoinAddress(address) {
  try {
    // Handle Bech32 addresses (starting with bc1)
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

module.exports = {
  isValidBitcoinAddress,
};
