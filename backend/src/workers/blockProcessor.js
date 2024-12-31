const { parentPort, workerData } = require("worker_threads");
const BitcoinRPC = require("../services/bitcoinRPC");

async function processBlock(block, addresses) {
  try {
    const transactions = new Set();

    for (const tx of block.tx) {
      const outputAddresses = tx.vout.flatMap(
        (vout) => vout.scriptPubKey.addresses || []
      );
      const inputAddresses = tx.vin.flatMap(
        (vin) => vin.prevout?.scriptPubKey?.addresses || []
      );
      const involvedAddresses = new Set([
        ...outputAddresses,
        ...inputAddresses,
      ]);

      for (const addr of addresses) {
        if (involvedAddresses.has(addr)) {
          transactions.add(BitcoinRPC.formatTransaction(tx));
          break;
        }
      }
    }

    return {
      height: block.height,
      transactions: Array.from(transactions),
    };
  } catch (error) {
    throw new Error(
      `Worker error processing block ${block.height}: ${error.message}`
    );
  }
}

parentPort.on("message", async ({ block, addresses }) => {
  try {
    const result = await processBlock(block, addresses);
    parentPort.postMessage({ success: true, result });
  } catch (error) {
    parentPort.postMessage({ success: false, error: error.message });
  }
});
