const axios = require("axios");
const { Level } = require("level");
const fs = require("fs");
const path = require("path");
const dbService = require("./dbService");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data");
const { Worker } = require("worker_threads");
const os = require("os");

const MAX_PARALLEL_REQUESTS = 16; // Increase from 5 to 16
const BASE_DELAY = 500; // Decrease from 1000 to 500ms
const MAX_RETRIES = 5; // Increase from 3 to 5
const MEMORY_CHECK_INTERVAL = 1000; // Check memory every 1000 blocks
const MEMORY_THRESHOLD = 0.85; // 85% memory usage threshold
const BLOCK_BATCH_SIZE = 1000; // Process 1000 blocks at a time

async function withBackoff(fn, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      console.log(
        `Attempt ${attempt}/${maxRetries} failed, waiting ${
          delay / 1000
        }s before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

class BitcoinRPC {
  constructor() {
    this.host = process.env.BITCOIN_RPC_HOST || "localhost";
    this.port = process.env.BITCOIN_RPC_PORT || 8332;
    this.user = process.env.BITCOIN_RPC_USER;
    this.pass = process.env.BITCOIN_RPC_PASS;
    this.timeout = parseInt(process.env.BITCOIN_RPC_TIMEOUT) || 300000;
    this.initialized = false; // Add initialization flag

    if (!this.user || !this.pass) {
      throw new Error("Bitcoin RPC credentials not configured");
    }

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

    this.txCache = new Map();
    this.TX_CACHE_SIZE = 10000; // Adjust based on your memory
    this.addressIndex = new Map(); // address -> Set of block heights

    // Performance tuning
    this.config = {
      batchSize: parseInt(process.env.BITCOIN_BATCH_SIZE) || 100,
      maxParallelRequests: parseInt(process.env.BITCOIN_MAX_PARALLEL) || 16,
      cacheSize: parseInt(process.env.BITCOIN_CACHE_SIZE) || 10000,
      retryDelay: parseInt(process.env.BITCOIN_RETRY_DELAY) || 500,
      maxRetries: parseInt(process.env.BITCOIN_MAX_RETRIES) || 5,
      memoryThreshold: parseFloat(process.env.BITCOIN_MEMORY_THRESHOLD) || 0.85,
      blockTimeout: parseInt(process.env.BITCOIN_BLOCK_TIMEOUT) || 300000, // 5 minutes for block fetching
      blockBatchSize:
        parseInt(process.env.BITCOIN_BLOCK_BATCH_SIZE) || BLOCK_BATCH_SIZE,
    };

    // Add database state tracking
    this.dbStatus = {
      isOpen: false,
      instance: null,
    };

    // Initialize worker pool
    this.workerPool = {
      size: Math.max(1, Math.min(os.cpus().length - 1, 4)), // Use up to 4 cores
      workers: [],
      busy: new Set(),
    };

    // Add status line tracking
    this.lastLines = 0;
  }

  async initialize() {
    if (this.initialized) return;

    console.log(`Connecting to Bitcoin node at ${this.host}:${this.port}`);
    await this.testConnection();
    this.initialized = true;
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

  async getAddressTransactions(addresses, progressCallback) {
    try {
      await this.initialize();

      const blockchainInfo = await this.getBlockchainInfo();
      const currentHeight = blockchainInfo.blocks;
      this.totalBlocks = currentHeight;
      this.startTime = Date.now();

      // Initialize database connection
      const db = await this.openDatabase();

      let startBlock = 0;
      let transactionsByAddress;

      try {
        const savedProgress = await db.get("scan_progress");
        startBlock = savedProgress.lastBlock + 1;
        transactionsByAddress = new Map(
          Object.entries(savedProgress.transactions).map(([addr, txs]) => [
            addr,
            new Set(txs),
          ])
        );
        console.log(`Resuming scan from block ${startBlock}`);
      } catch (err) {
        // No saved progress, start fresh
        transactionsByAddress = new Map(
          addresses.map((addr) => [addr, new Set()])
        );
        console.log("Starting fresh scan");
      }

      // Process one block at a time
      for (let height = startBlock; height < currentHeight; height++) {
        try {
          // Update progress through callback
          if (progressCallback) {
            progressCallback(height);
          }

          // Get block hash
          const hash = await this.call("getblockhash", [height]);

          // Get full block data
          const block = await this.call("getblock", [hash, 2]);

          // Process the block
          await this.processBlockTransactions(
            block,
            addresses,
            transactionsByAddress
          );

          // Save progress every block
          if (this.dbStatus.isOpen) {
            await db.put("scan_progress", {
              lastBlock: height,
              transactions: Object.fromEntries(
                Array.from(transactionsByAddress.entries()).map(
                  ([addr, txs]) => [addr, Array.from(txs)]
                )
              ),
              lastUpdated: Date.now(),
            });
          }
        } catch (error) {
          console.error(`\nError processing block ${height}:`, error.message);
          // Save progress before retrying
          if (this.dbStatus.isOpen) {
            await db.put("scan_progress", {
              lastBlock: height - 1,
              transactions: Object.fromEntries(
                Array.from(transactionsByAddress.entries()).map(
                  ([addr, txs]) => [addr, Array.from(txs)]
                )
              ),
              lastUpdated: Date.now(),
            });
          }

          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 5000));
          height--; // Retry this block
          continue;
        }
      }

      return Object.fromEntries(
        Array.from(transactionsByAddress.entries()).map(([addr, txs]) => [
          addr,
          Array.from(txs),
        ])
      );
    } catch (error) {
      console.error("Error in getAddressTransactions:", error);
      throw error;
    }
  }

  async processBlockTransactions(block, addresses, transactionsByAddress) {
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

      // Check if any of our target addresses are involved
      for (const addr of addresses) {
        if (involvedAddresses.has(addr)) {
          transactionsByAddress.get(addr).add(this.formatTransaction(tx));
          await this.updateAddressIndex(addr, block.height);
        }
      }
    }
  }

  // Helper method to format results consistently
  formatResults(addresses, transactionsByAddress) {
    return addresses.length === 1
      ? Array.from(transactionsByAddress.get(addresses[0]))
      : Object.fromEntries(
          Array.from(transactionsByAddress.entries()).map(([addr, txs]) => [
            addr,
            Array.from(txs),
          ])
        );
  }

  async getAddressScanProgress(address) {
    try {
      const info = await this.getBlockchainInfo();
      const currentHeight = info.blocks;

      try {
        const lastProcessed = await dbService.getLastProcessedBlock(address);
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
    const txid = tx.txid || tx.hash;
    if (this.txCache.has(txid)) {
      return this.txCache.get(txid);
    }

    try {
      const formatted = {
        hash: txid,
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

      // Cache the result
      if (this.txCache.size >= this.TX_CACHE_SIZE) {
        // Remove oldest entry
        const firstKey = this.txCache.keys().next().value;
        this.txCache.delete(firstKey);
      }
      this.txCache.set(txid, formatted);

      return formatted;
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
      // Only log blockchain info if not initialized
      if (!this.initialized) {
        console.log("Blockchain info:", info);
      }
      return info;
    } catch (error) {
      console.error("Error getting blockchain info:", error);
      throw error;
    }
  }

  async getRawMemPool() {
    return this.call("getrawmempool");
  }

  async call(method, params = [], client = this.client) {
    try {
      const response = await client.post("/", {
        jsonrpc: "1.0",
        id: Date.now(),
        method,
        params,
      });

      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      return response.data.result;
    } catch (error) {
      console.error(`Bitcoin RPC error (${method}):`, error.message);
      throw error;
    }
  }

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

  async getClient() {
    return this.client;
  }

  async getBlockHashes(startHeight, endHeight) {
    const hashes = [];
    const batchSize = 100;

    for (let i = startHeight; i < endHeight; i += batchSize) {
      const batch = Array.from(
        { length: Math.min(batchSize, endHeight - i) },
        (_, j) => i + j
      );

      const batchHashes = await Promise.all(
        batch.map((height) => this.call("getblockhash", [height]))
      );
      hashes.push(...batchHashes);
    }

    return hashes;
  }

  // Add method to update index
  async updateAddressIndex(address, blockHeight) {
    if (!this.addressIndex.has(address)) {
      this.addressIndex.set(address, new Set());
    }
    this.addressIndex.get(address).add(blockHeight);
  }

  // Add database management methods
  async openDatabase() {
    if (!this.dbStatus.isOpen) {
      this.dbStatus.instance = new Level(path.join(DB_PATH, "scan_progress"), {
        valueEncoding: "json",
        createIfMissing: true,
      });
      this.dbStatus.isOpen = true;
    }
    return this.dbStatus.instance;
  }

  async closeDatabase() {
    if (this.dbStatus.isOpen && this.dbStatus.instance) {
      await this.dbStatus.instance.close();
      this.dbStatus.isOpen = false;
      this.dbStatus.instance = null;
    }
  }

  async initWorkerPool() {
    for (let i = 0; i < this.workerPool.size; i++) {
      const worker = new Worker(
        path.join(__dirname, "../workers/blockProcessor.js")
      );
      this.workerPool.workers.push(worker);
    }
  }

  async getAvailableWorker() {
    const worker = this.workerPool.workers.find(
      (w) => !this.workerPool.busy.has(w)
    );
    if (worker) {
      this.workerPool.busy.add(worker);
      return worker;
    }
    return null;
  }

  // Helper function to format time
  formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  // Helper to clear previous lines
  clearLines(count) {
    process.stdout.write(`\x1b[${count}A\x1b[0J`);
  }

  // Update the table formatting methods
  formatProgressTable(current, total, overallProgress, batchProgress) {
    const formattedCurrent = current.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });
    const formattedTotal = total.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });

    const table = [
      "┌────────────────────────────────────────────────────┐",
      "│ Progress Update                                    │",
      "├────────────────────────────────────────────────────┤",
      `│ Current Block:     ${formattedCurrent.padEnd(
        10
      )} of ${formattedTotal.padEnd(17)} │`,
      `│ Overall Progress:  ${overallProgress.padStart(
        7
      )}%                        │`,
      `│ Batch Progress:    ${batchProgress.padStart(
        7
      )}%                        │`,
      "└────────────────────────────────────────────────────┘",
    ].join("\n");

    // Clear previous table if it exists
    if (this.lastLines > 0) {
      this.clearLines(this.lastLines);
    }

    // Update line count
    this.lastLines = table.split("\n").length;

    return table;
  }

  formatInitialTable(totalBlocks, addressCount) {
    const formattedTotal = totalBlocks.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });
    const formattedAddresses = addressCount.toString();

    return [
      "┌────────────────────────────────────────────────────┐",
      "│ Starting Block Scan                                │",
      "├────────────────────────────────────────────────────┤",
      `│ Total Blocks:      ${formattedTotal.padEnd(31)} │`,
      `│ Addresses to Scan: ${formattedAddresses.padEnd(31)} │`,
      "└────────────────────────────────────────────────────┘",
    ].join("\n");
  }
}

// Export singleton instance
module.exports = new BitcoinRPC();
