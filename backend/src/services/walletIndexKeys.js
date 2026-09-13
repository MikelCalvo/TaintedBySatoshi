function walletHopIndexKey(address, degree) {
  if (!Number.isSafeInteger(degree) || degree < 0) {
    throw new TypeError('Wallet hops must be a nonnegative safe integer');
  }
  if (typeof address !== 'string' || !address || address.includes(':')) {
    throw new TypeError('Wallet address is required');
  }
  return `h:${String(degree).padStart(16, '0')}:${address}`;
}

module.exports = { walletHopIndexKey };
