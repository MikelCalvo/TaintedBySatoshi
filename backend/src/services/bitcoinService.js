const dbService = require("./dbService");

const { SATOSHI_ADDRESSES, SATOSHI_NOTES } = require("../../data/satoshiAddresses");

async function checkAddressConnection(address) {
  let db = null;

  try {
    db = await dbService.init();

    // Quick check for Satoshi's addresses
    if (SATOSHI_ADDRESSES.includes(address)) {
      return {
        isConnected: true,
        isSatoshiAddress: true,
        degree: 0,
        note: SATOSHI_NOTES[address] || "Known Satoshi address",
        connectionPath: [],
        transactions: [],
      };
    }

    // Add timeout for database operations
    const taintedInfo = await Promise.race([
      db.get(`tainted:${address}`).catch(() => null),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Database operation timeout")), 15000)
      ),
    ]);

    if (!taintedInfo) {
      return {
        isConnected: false,
        isSatoshiAddress: false,
        degree: 0,
        connectionPath: [],
        transactions: [],
      };
    }

    // Get cached transaction details with timeout
    const transactions = await Promise.all(
      taintedInfo.path.map(async (p) => {
        try {
          const tx = await Promise.race([
            db.get(`tx:${p.txHash}`).catch(() => null),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Transaction fetch timeout")),
                5000
              )
            ),
          ]);
          return tx || { hash: p.txHash, amount: p.amount };
        } catch (err) {
          console.warn(`Failed to fetch transaction ${p.txHash}:`, err.message);
          return { hash: p.txHash, amount: p.amount };
        }
      })
    );

    return {
      isConnected: true,
      isSatoshiAddress: false,
      degree: taintedInfo.degree,
      connectionPath: taintedInfo.path,
      transactions,
    };
  } catch (error) {
    console.error("Database error:", error);
    throw error;
  }
}

module.exports = {
  checkAddressConnection,
  SATOSHI_ADDRESSES,
};
