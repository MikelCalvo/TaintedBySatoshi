const bitcoin = require('bitcoinjs-lib');

function isValidBitcoinAddress(address) {
  try {
    // Try to decode the address
    bitcoin.address.fromBase58Check(address);
    
    // Accept all valid Bitcoin addresses
    // P2PKH: starts with 1
    // P2SH: starts with 3
    // Bech32 (native SegWit): starts with bc1
    return (
      address.startsWith('1') || // Legacy P2PKH
      address.startsWith('3') || // P2SH
      address.toLowerCase().startsWith('bc1') // Native SegWit
    );
  } catch (error) {
    // For Bech32 addresses, try specific Bech32 validation
    try {
      if (address.toLowerCase().startsWith('bc1')) {
        bitcoin.address.fromBech32(address);
        return true;
      }
    } catch {
      // Not a valid Bech32 address
    }
    return false;
  }
}

module.exports = {
  isValidBitcoinAddress
}; 