require("dotenv").config();
const bitcoinRPC = require("../services/bitcoinRPC");

/**
 * Extract addresses from early blocks (0-2) that are not in Patoshi list
 * These blocks were mined by Satoshi but don't match Patoshi pattern
 */

async function extractEarlyBlocks() {
  console.log("🔍 Extracting addresses from early blocks (0-2)...\n");

  await bitcoinRPC.initialize();

  const earlyBlocks = [0, 1, 2];
  const addresses = [];

  for (const height of earlyBlocks) {
    try {
      const hash = await bitcoinRPC.call("getblockhash", [height]);
      const block = await bitcoinRPC.call("getblock", [hash, 2]);

      const coinbaseTx = block.tx[0];

      for (const vout of coinbaseTx.vout) {
        const address = bitcoinRPC.getAddressFromScript(vout.scriptPubKey);

        if (address) {
          addresses.push({
            address,
            blockHeight: height,
            timestamp: block.time,
            amount: vout.value,
          });
          console.log(`Block ${height}: ${address} (${vout.value} BTC)`);
        }
      }
    } catch (error) {
      console.error(`Error processing block ${height}:`, error.message);
    }
  }

  console.log(`\n✅ Found ${addresses.length} addresses from early blocks`);
  return addresses;
}

if (require.main === module) {
  extractEarlyBlocks()
    .then((addresses) => {
      console.log("\n📋 Early block addresses:");
      console.log(JSON.stringify(addresses, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

module.exports = { extractEarlyBlocks };
