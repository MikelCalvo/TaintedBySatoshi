require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bitcoinRPC = require("../services/bitcoinRPC");
const { PATOSHI_BLOCKS } = require("../data/patoshiBlocks");

/**
 * Script to extract ALL coinbase addresses from Patoshi blocks
 *
 * Uses verified list of Patoshi blocks (curated by Sergio Demian Lerner & Jameson Lopp)
 * Reference: https://github.com/bensig/patoshi-addresses
 *
 * Research: https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/
 */

const PROGRESS_INTERVAL = 500; // Show progress every N blocks

async function extractPatoshiAddresses() {
  console.log("🔍 Extracting Patoshi coinbase addresses...\n");

  await bitcoinRPC.initialize();

  const patoshiAddresses = new Set();
  const addressDetails = new Map(); // address -> { blockHeight, timestamp, amount }
  let lastBlock = null;

  // Add early blocks (0-2) that were mined by Satoshi but don't match Patoshi pattern
  const EARLY_SATOSHI_ADDRESSES = [
    { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", blockHeight: 0, timestamp: 1231006505, amount: 50 }, // Genesis
    { address: "12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX", blockHeight: 1, timestamp: 1231469665, amount: 50 },
    { address: "1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1", blockHeight: 2, timestamp: 1231469744, amount: 50 },
  ];

  console.log(`📌 Including ${EARLY_SATOSHI_ADDRESSES.length} early Satoshi addresses (blocks 0-2)`);
  for (const { address, blockHeight, timestamp, amount } of EARLY_SATOSHI_ADDRESSES) {
    patoshiAddresses.add(address);
    addressDetails.set(address, { blockHeight, timestamp, amount });
    console.log(`   Block ${blockHeight}: ${address}`);
  }
  console.log();

  const totalBlocks = PATOSHI_BLOCKS.length;
  const firstBlock = PATOSHI_BLOCKS[0];
  const lastBlockHeight = PATOSHI_BLOCKS[totalBlocks - 1];

  console.log(`📋 Using verified Patoshi block list`);
  console.log(`   Total blocks: ${totalBlocks.toLocaleString()}`);
  console.log(`   Range: ${firstBlock.toLocaleString()} to ${lastBlockHeight.toLocaleString()}`);
  console.log(`   Source: Sergio Demian Lerner & Jameson Lopp\n`);

  let startTime = Date.now();
  let processedCount = 0;

  for (const height of PATOSHI_BLOCKS) {
    try {
      processedCount++;

      // Progress update
      if (processedCount % PROGRESS_INTERVAL === 0) {
        const elapsed = Date.now() - startTime;
        const blocksPerSecond = processedCount / (elapsed / 1000);
        const remaining = totalBlocks - processedCount;
        const eta = Math.round(remaining / blocksPerSecond);

        console.log(
          `Progress: ${processedCount.toLocaleString()}/${totalBlocks.toLocaleString()} blocks ` +
          `(${((processedCount / totalBlocks) * 100).toFixed(2)}%) - ` +
          `Current: ${height.toLocaleString()} - ` +
          `ETA: ${Math.floor(eta / 60)}m ${eta % 60}s`
        );
      }

      // Get block
      const hash = await bitcoinRPC.call("getblockhash", [height]);
      const block = await bitcoinRPC.call("getblock", [hash, 2]);
      lastBlock = block;

      // Get coinbase transaction (first transaction in block)
      const coinbaseTx = block.tx[0];

      // Extract all addresses from coinbase outputs
      for (const vout of coinbaseTx.vout) {
        const address = bitcoinRPC.getAddressFromScript(vout.scriptPubKey);

        if (address) {
          patoshiAddresses.add(address);

          // Store details of first occurrence
          if (!addressDetails.has(address)) {
            addressDetails.set(address, {
              blockHeight: height,
              timestamp: block.time,
              amount: vout.value,
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error processing block ${height}:`, error.message);
      continue;
    }
  }

  console.log(`\n✅ Scan complete!\n`);
  console.log("📊 Results:");
  console.log("=".repeat(60));
  console.log(`Patoshi addresses found: ${patoshiAddresses.size.toLocaleString()}`);
  console.log(`Patoshi blocks processed: ${totalBlocks.toLocaleString()}`);
  console.log(`Block range: ${firstBlock.toLocaleString()} to ${lastBlockHeight.toLocaleString()}`);
  if (lastBlock) {
    const firstTimestamp = addressDetails.values().next().value.timestamp;
    console.log(`Time period: ${new Date(firstTimestamp * 1000).toISOString()} to ${new Date(lastBlock.time * 1000).toISOString()}`);
  }

  // Save to file
  const outputPath = path.join(__dirname, "../../data/satoshiAddresses.js");
  const sortedAddresses = Array.from(patoshiAddresses).sort();

  // Create address metadata map
  const addressMetadata = {};
  for (const [address, details] of addressDetails.entries()) {
    addressMetadata[address] = {
      blockHeight: details.blockHeight,
      firstSeen: details.timestamp,
      amount: details.amount,
    };
  }

  const fileContent = `/**
 * Satoshi Nakamoto's Bitcoin Addresses
 *
 * Includes:
 * 1. Early blocks (0-2): Genesis + first mined blocks by Satoshi
 * 2. Verified Patoshi blocks (3-49,973): Identified via Patoshi Pattern Analysis
 *
 * Curated by:
 * - Sergio Demian Lerner (Patoshi Pattern discovery)
 * - Jameson Lopp (validation & curation)
 *
 * Source: https://github.com/bensig/patoshi-addresses
 * Research: https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/
 *
 * Total addresses: ${patoshiAddresses.size.toLocaleString()}
 * - Early blocks (0-2): 3 addresses
 * - Patoshi blocks (3-49,973): ${totalBlocks.toLocaleString()} blocks
 *
 * Generated: ${new Date().toISOString()}
 */

const SATOSHI_ADDRESSES = [
${sortedAddresses.map(addr => `  "${addr}",`).join('\n')}
];

// Metadata for each address (block height, first seen timestamp, amount)
const ADDRESS_METADATA = ${JSON.stringify(addressMetadata, null, 2)};

// Known addresses with historical notes
const SATOSHI_NOTES = {
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa": "Genesis block (Block 0) - First Bitcoin address ever",
  "12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S": "Received change from first Bitcoin transaction",
};

module.exports = {
  SATOSHI_ADDRESSES,
  ADDRESS_METADATA,
  SATOSHI_NOTES,
};
`;

  fs.writeFileSync(outputPath, fileContent);
  console.log(`\n💾 Saved to: ${outputPath}`);

  // Show sample addresses
  console.log(`\n📋 Sample Patoshi addresses (first 10):`);
  sortedAddresses.slice(0, 10).forEach((addr, i) => {
    const details = addressDetails.get(addr);
    console.log(`  ${i + 1}. ${addr}`);
    console.log(`     Block ${details.blockHeight.toLocaleString()}, Amount: ${details.amount} BTC`);
  });

  console.log(`\n✅ Extraction from verified Patoshi blocks complete!`);
  console.log(`   Source: https://github.com/bensig/patoshi-addresses`);
  console.log(`   Research: https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/`);
  console.log(`\n💡 The generated file includes:`);
  console.log(`   • SATOSHI_ADDRESSES: All addresses from verified Patoshi blocks`);
  console.log(`   • ADDRESS_METADATA: Block height, timestamp, and amount for each address`);

  return {
    addresses: sortedAddresses,
    count: patoshiAddresses.size,
  };
}

if (require.main === module) {
  extractPatoshiAddresses()
    .then((result) => {
      console.log(`\n✅ Extraction completed: ${result.count} Patoshi addresses`);
      console.log(`\n🚀 Next step: Run 'npm run update-satoshi-data' to scan the blockchain`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Extraction failed:", error);
      process.exit(1);
    });
}

module.exports = { extractPatoshiAddresses };
