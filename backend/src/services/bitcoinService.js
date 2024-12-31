const dbService = require("./dbService");

// Known Satoshi addresses with their balances and notes
const SATOSHI_ADDRESSES = [
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // Genesis address (100.15 BTC)
  "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S", // First user-to-user transaction to Hal Finney (18.44 BTC)
  "12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX", // 51.35 BTC
  "1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1", // 50.08 BTC
  "1FvzCLoTPGANNjWoUo6jUGuAG3wg1w4YjR", // 50.01 BTC
  "15ubicBBWFnvoZLT7GiU2qxjRaKJPdkDMG", // 50.07 BTC
  "1JfbZRwdDHKZmuiZgYArJZhcuuzuw2HuMu", // 50.01 BTC
  "1GkQmKAmHtNfnD3LHhTkewJxKHVSta4m2a", // 50.00 BTC
  "16LoW7y83wtawMg5XmT4M3Q7EdjjUmenjM", // 50.02 BTC
  "1J6PYEzr4CUoGbnXrELyHszoTSz3wCsCaj", // 50.00 BTC
];

// Notes for special Satoshi addresses
const SATOSHI_NOTES = {
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa": "Genesis block address",
  "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S":
    "First user-to-user Bitcoin transaction (to Hal Finney)",
};

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
