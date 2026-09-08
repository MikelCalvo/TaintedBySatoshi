require("dotenv").config();
const { extractPatoshiAddresses } = require("./extractPatoshiAddresses");

async function updateSatoshiTransactions() {
  console.log("Patoshi address extraction still runs from this script.");
  console.log("The live UTXO taint scan now belongs to the backend sync service.");
  await extractPatoshiAddresses();
  console.log("Start the backend to scan from genesis with schema version 4.");
}

if (require.main === module) {
  updateSatoshiTransactions()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Update failed:", error);
      process.exit(1);
    });
}

module.exports = { updateSatoshiTransactions };
