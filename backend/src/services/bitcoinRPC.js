const axios = require("axios");
const { Level } = require("level");
const fs = require("fs");
const path = require("path");

class BitcoinRPC {
  constructor() {
    this.host = process.env.BITCOIN_RPC_HOST || "localhost";
    this.port = process.env.BITCOIN_RPC_PORT || 8332;
    this.user = process.env.BITCOIN_RPC_USER;
    this.pass = process.env.BITCOIN_RPC_PASS;
    this.timeout = parseInt(process.env.BITCOIN_RPC_TIMEOUT) || 30000;

    if (!this.user || !this.pass) {
      throw new Error("Bitcoin RPC credentials not configured");
    }

    console.log(`Connecting to Bitcoin node at ${this.host}:${this.port}`);

    // Test connection immediately
    this.testConnection();

    this.client = axios.create({
      baseURL: `http://${this.host}:${this.port}`,
      auth: {
        username: this.user,
        password: this.pass,
      },
      timeout: this.timeout,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Ensure data directory exists
    const dataDir = path.join(__dirname, "../../data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  async testConnection() {
    try {
      const response = await axios.post(
        `http://${this.host}:${this.port}`,
        {
          jsonrpc: "1.0",
          id: "test",
          method: "getblockchaininfo",
          params: [],
        },
        {
          auth: {
            username: this.user,
            password: this.pass,
          },
          timeout: this.timeout,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      const info = response.data.result;
      console.log("\n=== Bitcoin Node Status ===");
      console.log("------------------------");
      console.log(`Network:     ${info.chain}`);
      console.log(`Blocks:      ${info.blocks.toLocaleString()}`);
      console.log(`Headers:     ${info.headers.toLocaleString()}`);
      console.log(
        `Size:        ${(info.size_on_disk / 1024 / 1024 / 1024).toFixed(2)} GB`
      );
      console.log("------------------------");

      // Add sync check
      if (info.initialblockdownload) {
        const progress = (info.verificationprogress * 100).toFixed(2);
        const remainingBlocks = info.headers - info.blocks;
        const estimatedTimeHours = Math.round((remainingBlocks * 5) / 60); // Assuming ~5 seconds per block
        const estimatedSizeGB = (
          ((info.size_on_disk / info.blocks) * remainingBlocks) /
          1024 /
          1024 /
          1024
        ).toFixed(2);

        console.log("\n=== Sync Status ===");
        console.log("------------------------");
        console.log(`Progress:    ${progress}%`);
        console.log(`Remaining:   ${remainingBlocks.toLocaleString()} blocks`);
        console.log(`Est. Time:   ~${estimatedTimeHours} hours`);
        console.log(`Est. Size:   ~${estimatedSizeGB} GB additional`);
        console.log("------------------------\n");

        console.error(`
╔════════════════════════════════════════╗
║              Sync Required             ║
╚════════════════════════════════════════╝

Bitcoin node is still synchronizing with the network.
Please wait for the sync to complete before running the update-satoshi-data script.

Current Progress: ${progress}%
`);
        process.exit(1);
      }

      console.log("\n✓ Node is fully synced!");
      console.log("------------------------\n");
      return info;
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        console.error(`
╔════════════════════════════════════════╗
║          Connection Failed!            ║
╚════════════════════════════════════════╝

Could not connect to Bitcoin node at ${this.host}:${this.port}

Please check:
✗ Is Bitcoin Core running?
✗ Is RPC server enabled? (server=1 in bitcoin.conf)
✗ Are RPC credentials correct?
✗ Is RPC port (${this.port}) accessible?
`);
      } else {
        console.error(`
╔════════════════════════════════════════╗
║              Error                     ║
╚════════════════════════════════════════╝

${error.message}
`);
      }
      process.exit(1);
    }
  }

  async initDB() {
    if (!this.db) {
      this.db = new Level("./data/satoshi-transactions", {
        valueEncoding: "json",
      });
      // Wait for the database to be ready
      await new Promise((resolve, reject) => {
        this.db.once("ready", resolve);
        this.db.once("error", reject);
      });
    }
    return this.db;
  }

  async closeDB() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  async call(method, params = []) {
    try {
      const response = await this.client.post("/", {
        jsonrpc: "1.0",
        id: Date.now(),
        method,
        params,
      });

      if (response.data.error) {
        console.error(`RPC Error in ${method}:`, response.data.error); // Add detailed error logging
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      return response.data.result;
    } catch (error) {
      console.error(`Bitcoin RPC error (${method}):`, {
        message: error.message,
        response: error.response?.data,
        code: error.code,
        method,
        params,
        stack: error.stack, // Add stack trace
      });
      throw error;
    }
  }

  // Get transaction details
  async getTransaction(txid) {
    try {
      // First try getrawtransaction
      const tx = await this.call("getrawtransaction", [txid, true]);
      return this.formatTransaction(tx);
    } catch (error) {
      // If getrawtransaction fails, try gettransaction as fallback
      try {
        const tx = await this.call("gettransaction", [txid, true]);
        return this.formatTransaction({
          ...tx,
          txid: tx.txid || txid,
          vin: tx.vin || [],
          vout: tx.vout || [],
        });
      } catch (fallbackError) {
        console.error("Failed to get transaction:", fallbackError);
        throw new Error(
          "Unable to fetch transaction. Make sure -txindex is enabled or the transaction is in the wallet."
        );
      }
    }
  }

  // Get address transactions
  async getAddressTransactions(address) {
    await this.initDB(); // Ensure DB is initialized
    try {
      console.log(`Getting transactions for address: ${address}`); // Add debug logging

      // Get current block height
      const info = await this.getBlockchainInfo();
      if (!info || !info.blocks) {
        throw new Error("Could not get current block height");
      }

      const currentHeight = info.blocks;
      console.log(`Current block height: ${currentHeight}`); // Add debug logging

      // Get the last processed block for this address
      let startHeight = 0;
      try {
        const lastProcessed = await this.db.get(`lastBlock:${address}`);
        startHeight = lastProcessed + 1;
        console.log(`Resuming scan from block ${startHeight} for ${address}`);
      } catch (err) {
        console.log(`Starting fresh scan for ${address}`);
      }

      if (startHeight > currentHeight) {
        console.log(`Already up to date for ${address}`);
        return [];
      }

      const transactions = new Set();

      // Scan blocks in batches to avoid overwhelming the node
      const batchSize = 10;
      for (
        let height = startHeight;
        height <= currentHeight;
        height += batchSize
      ) {
        const endHeight = Math.min(height + batchSize, currentHeight);
        let batchSuccess = true;

        try {
          for (let h = height; h <= endHeight; h++) {
            const blockHash = await this.call("getblockhash", [h]);
            const block = await this.call("getblock", [blockHash, 2]); // 2 for verbose tx data

            // Check each transaction in the block
            for (const tx of block.tx) {
              // Check outputs for the address
              const hasAddress = tx.vout.some((vout) =>
                vout.scriptPubKey.addresses?.includes(address)
              );

              // Check inputs for the address
              const hasAddressInput = tx.vin.some((vin) =>
                vin.prevout?.scriptPubKey?.addresses?.includes(address)
              );

              if (hasAddress || hasAddressInput) {
                transactions.add(this.formatTransaction(tx));
              }
            }

            // Update the last processed block after each successful block
            await this.db.put(`lastBlock:${address}`, h);
          }
        } catch (blockError) {
          console.error(
            `Error processing blocks ${height} to ${endHeight}:`,
            blockError.message
          );
          batchSuccess = false;
          // Don't update lastBlock if there was an error
          break;
        }

        if (batchSuccess) {
          console.log(
            `Processed blocks ${height} to ${endHeight} (${Math.round(
              (endHeight / currentHeight) * 100
            )}%)`
          );
        }
      }

      return Array.from(transactions);
    } catch (error) {
      console.error("Failed to get address transactions:", error);
      throw new Error(`Unable to fetch address transactions: ${error.message}`);
    }
  }

  // Add method to get scanning progress
  async getAddressScanProgress(address) {
    try {
      const info = await this.getBlockchainInfo();
      const currentHeight = info.blocks;

      try {
        const lastProcessed = await this.db.get(`lastBlock:${address}`);
        return {
          lastProcessed,
          currentHeight,
          progress: (lastProcessed / currentHeight) * 100,
        };
      } catch (err) {
        return {
          lastProcessed: 0,
          currentHeight,
          progress: 0,
        };
      }
    } catch (error) {
      throw new Error(`Unable to get scan progress: ${error.message}`);
    }
  }

  // Format transaction to match our expected structure
  formatTransaction(tx) {
    try {
      return {
        hash: tx.txid || tx.hash,
        time: tx.time,
        inputs: tx.vin.map((input) => ({
          prev_out: {
            addr: input.prevout?.scriptPubKey?.addresses?.[0] || input.address,
            value: input.prevout
              ? Math.round(input.prevout.value * 100000000) // Convert BTC to satoshis
              : input.value
              ? Math.round(input.value * 100000000)
              : 0,
          },
        })),
        out: tx.vout
          .map((output) => ({
            addr: output.scriptPubKey.addresses?.[0],
            value: Math.round(output.value * 100000000), // Convert BTC to satoshis
          }))
          .filter((out) => out.addr), // Filter out non-standard outputs
      };
    } catch (error) {
      console.error("Error formatting transaction:", error);
      return {
        hash: tx.txid || tx.hash,
        time: tx.time,
        inputs: [],
        out: [],
      };
    }
  }

  // Batch process multiple transactions
  async batchGetTransactions(txids) {
    const batchSize = parseInt(process.env.BATCH_SIZE) || 100;
    const results = [];

    for (let i = 0; i < txids.length; i += batchSize) {
      const batch = txids.slice(i, i + batchSize);
      const promises = batch.map((txid) => this.getTransaction(txid));
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    return results;
  }

  async getBlockchainInfo() {
    try {
      const info = await this.call("getblockchaininfo");
      console.log("Blockchain info:", info);
      return info;
    } catch (error) {
      console.error("Error getting blockchain info:", error);
      throw error;
    }
  }

  async getRawMemPool() {
    return this.call("getrawmempool");
  }
}

// Export singleton instance
module.exports = new BitcoinRPC();
