require("dotenv").config();
const BitcoinRPC = require("../services/bitcoinRPC");

async function checkNodeStatus() {
  const bitcoinRPC = BitcoinRPC;

  try {
    // Check basic connectivity first
    console.log("Checking Bitcoin node connection...");
    const networkInfo = await bitcoinRPC.call("getnetworkinfo");
    console.log("Connected to Bitcoin Core version:", networkInfo.version);
    console.log("Network:", networkInfo.networkactive ? "active" : "inactive");
    console.log("Connections:", networkInfo.connections);

    // Add warnings if connection count is low
    if (networkInfo.connections < 3) {
      console.log("⚠️  Warning: Low peer count. More connections recommended.");
    }
    console.log("\n");

    // Check sync status
    const info = await bitcoinRPC.getBlockchainInfo();
    console.log("Node status:");
    console.log("- Blocks:", info.blocks);
    console.log("- Headers:", info.headers);
    console.log(
      "- Verification progress:",
      (info.verificationprogress * 100).toFixed(2) + "%"
    );
    console.log("- Initial block download:", info.initialblockdownload);
    console.log("- Pruned:", info.pruned);

    // Add estimated time remaining for sync
    if (info.blocks < info.headers) {
      const blocksRemaining = info.headers - info.blocks;
      console.log("\nSync Status:");
      console.log(`- ${blocksRemaining} blocks remaining`);

      // Estimate time remaining (assuming ~10 mins per block, but actual speed varies)
      const estimatedMinutes = blocksRemaining * 0.5; // Assuming 2 blocks per minute on average
      const hours = Math.floor(estimatedMinutes / 60);
      const minutes = Math.floor(estimatedMinutes % 60);
      console.log(
        `- Estimated time remaining: ~${hours} hours ${minutes} minutes`
      );
      console.log(
        "  (This is a rough estimate and actual time may vary significantly)"
      );
    } else {
      console.log("\n✓ Blockchain fully synced");
    }

    // Check if we can access mempool (basic RPC functionality)
    console.log("\nChecking mempool access...");
    const mempool = await bitcoinRPC.getRawMemPool();
    console.log(`✓ Mempool access OK (${mempool.length} transactions pending)`);

    // Add memory pool size info
    const mempoolInfo = await bitcoinRPC.call("getmempoolinfo");
    console.log(
      `- Mempool size: ${(mempoolInfo.bytes / 1024 / 1024).toFixed(2)} MB`
    );
    console.log(
      `- Mempool max size: ${(mempoolInfo.maxmempool / 1024 / 1024).toFixed(
        2
      )} MB`
    );
  } catch (error) {
    console.error("\n❌ Error checking node status:", error.message);
    if (error.response?.data) {
      console.error(
        "RPC Response:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    return;
  }

  try {
    // Test if txindex is available
    console.log("\nChecking transaction index...");
    console.log("Attempting to query a historical transaction...");

    // Using the first-ever Bitcoin transaction (Satoshi to Hal Finney)
    await bitcoinRPC.getTransaction(
      "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"
    );
    console.log("✓ Transaction index (txindex) is enabled and working");
  } catch (error) {
    console.log("❌ Transaction index check failed");

    if (error.response?.data?.error?.message?.includes("No such mempool")) {
      console.log("\nStatus: Transaction found but not indexed");
      console.log("This usually means:");
      console.log("- txindex=1 is configured");
      console.log("- Index is still being built");
    } else if (error.response?.data?.error?.code === -1) {
      console.log("\nAction needed:");
      console.log("1. Add txindex=1 to bitcoin.conf");
      console.log("2. Restart Bitcoin Core");
      console.log("3. Wait for the index to be built (can take several hours)");
      console.log("\nTypical location of bitcoin.conf:");
      console.log("- Linux: ~/.bitcoin/bitcoin.conf");
      console.log("- Windows: %APPDATA%\\Bitcoin\\bitcoin.conf");
      console.log(
        "- macOS: ~/Library/Application Support/Bitcoin/bitcoin.conf"
      );
    } else {
      console.log("\nUnexpected error:", error.message);
      if (error.response?.data) {
        console.log(
          "RPC Response:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
    }
  }
}

checkNodeStatus().catch(console.error);
