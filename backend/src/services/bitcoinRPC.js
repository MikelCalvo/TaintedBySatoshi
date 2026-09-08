const axios = require("axios");
const http = require("http");
const bitcoin = require("bitcoinjs-lib");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data");

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
      logger.info(
        `Attempt ${attempt}/${maxRetries} failed, waiting ${
          delay / 1000
        }s before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isTransientRpcError(error) {
  return (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(
      error?.code
    ) ||
    error?.response?.status === 429 ||
    error?.response?.status >= 500
  );
}

class BitcoinRPC {
  constructor(options = {}) {
    this.host = options.host || process.env.BITCOIN_RPC_HOST || "localhost";
    this.port = options.port || process.env.BITCOIN_RPC_PORT || 8332;
    this.user = options.user || process.env.BITCOIN_RPC_USER;
    this.pass = options.pass || process.env.BITCOIN_RPC_PASS;
    this.timeout = parseInt(process.env.BITCOIN_RPC_TIMEOUT) || 300000;
    this.initialized = false;
    this.addressCache = new Map();

    if (!this.user || !this.pass) {
      throw new Error("Bitcoin RPC credentials not configured");
    }

    this.client =
      options.client ||
      axios.create({
        baseURL: `http://${this.host}:${this.port}`,
        auth: {
          username: this.user,
          password: this.pass,
        },
        timeout: this.timeout,
        httpAgent: new http.Agent({
          keepAlive: true,
          maxSockets:
            options.maxParallelRequests ||
            parseInt(process.env.BITCOIN_MAX_PARALLEL) ||
            16,
        }),
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
    this.TX_CACHE_SIZE = 10000;

    // Performance tuning
    this.config = {
      batchSize: parseInt(process.env.BITCOIN_BATCH_SIZE) || 100,
      maxParallelRequests:
        options.maxParallelRequests ||
        parseInt(process.env.BITCOIN_MAX_PARALLEL) ||
        16,
      cacheSize: parseInt(process.env.BITCOIN_CACHE_SIZE) || 10000,
      retryDelay:
        options.retryDelay ?? (parseInt(process.env.BITCOIN_RETRY_DELAY) || 500),
      maxRetries:
        options.maxRetries || parseInt(process.env.BITCOIN_MAX_RETRIES) || 5,
      memoryThreshold: parseFloat(process.env.BITCOIN_MEMORY_THRESHOLD) || 0.85,
      blockTimeout: parseInt(process.env.BITCOIN_BLOCK_TIMEOUT) || 300000, // 5 minutes for block fetching
      blockBatchSize:
        parseInt(process.env.BITCOIN_BLOCK_BATCH_SIZE) || BLOCK_BATCH_SIZE,
    };
  }

  async initialize() {
    if (this.initialized) return;

    logger.info(`Connecting to Bitcoin node at ${this.host}:${this.port}`);
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
      logger.info("\n=== Bitcoin Node Status ===");
      logger.info("------------------------");
      logger.info(`Network:     ${info.chain}`);
      logger.info(`Blocks:      ${info.blocks.toLocaleString()}`);
      logger.info(`Headers:     ${info.headers.toLocaleString()}`);
      logger.info(
        `Size:        ${(info.size_on_disk / 1024 / 1024 / 1024).toFixed(2)} GB`
      );
      logger.info("------------------------");

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

        logger.info("\n=== Sync Status ===");
        logger.info("------------------------");
        logger.info(`Progress:    ${progress}%`);
        logger.info(`Remaining:   ${remainingBlocks.toLocaleString()} blocks`);
        logger.info(`Est. Time:   ~${estimatedTimeHours} hours`);
        logger.info(`Est. Size:   ~${estimatedSizeGB} GB additional`);
        logger.info("------------------------\n");

        logger.error(`
╔════════════════════════════════════════╗
║              Sync Required             ║
╚════════════════════════════════════════╝

Bitcoin node is still synchronizing with the network.
Please wait for the sync to complete before running the update-satoshi-data script.

Current Progress: ${progress}%
`);
        process.exit(1);
      }

      logger.info("\n✓ Node is fully synced!");
      logger.info("------------------------\n");
      return info;
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        logger.error(`
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
        logger.error(`
╔════════════════════════════════════════╗
║              Error                     ║
╚════════════════════════════════════════╝

${error.message}
`);
      }
      process.exit(1);
    }
  }

  // Helper to get address from scriptPubKey
  getAddressFromScript(scriptPubKey) {
    if (!scriptPubKey) return null;

    // Case 1: Standard address field (P2PKH, P2SH, Bech32)
    if (scriptPubKey.address) return scriptPubKey.address;
    if (scriptPubKey.addresses && scriptPubKey.addresses.length > 0)
      return scriptPubKey.addresses[0];

    // Case 2: P2PK (Pay to Public Key) - Common in early blocks
    if (scriptPubKey.type === "pubkey" && scriptPubKey.asm) {
      try {
        // Extract pubkey from ASM (it's the first part before OP_CHECKSIG)
        const parts = scriptPubKey.asm.split(" ");
        if (parts.length > 0) {
          const pubkeyHex = parts[0];

          // Check cache first
          if (this.addressCache.has(pubkeyHex)) {
            return this.addressCache.get(pubkeyHex);
          }

          const pubkey = Buffer.from(pubkeyHex, "hex");
          const { address } = bitcoin.payments.p2pkh({ pubkey });

          // Cache the result
          if (this.addressCache.size > 10000) this.addressCache.clear();
          this.addressCache.set(pubkeyHex, address);

          return address;
        }
      } catch (e) {
        // Ignore conversion errors
      }
    }

    return null;
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
        inputs: tx.vin.map((input) => {
          const addr =
            this.getAddressFromScript(input.prevout?.scriptPubKey) ||
            input.address;
          return {
            prev_out: {
              addr,
              value: input.prevout
                ? Math.round(input.prevout.value * 100000000)
                : input.value
                ? Math.round(input.value * 100000000)
                : 0,
            },
          };
        }),
        out: tx.vout
          .map((output) => {
            const addr = this.getAddressFromScript(output.scriptPubKey);
            return {
              addr,
              value: Math.round(output.value * 100000000),
            };
          })
          .filter((out) => out.addr),
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
      logger.error("Error formatting transaction:", error);
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
        logger.info("Blockchain info:", info);
      }
      return info;
    } catch (error) {
      logger.error("Error getting blockchain info:", error);
      throw error;
    }
  }

  async getRawMemPool() {
    return this.call("getrawmempool");
  }

  async call(method, params = [], client = this.client) {
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await client.post("/", {
          jsonrpc: "1.0",
          id: `${Date.now()}-${attempt}`,
          method,
          params,
        });

        if (response.data.error) {
          const error = new Error(`RPC Error: ${response.data.error.message}`);
          error.rpcCode = response.data.error.code;
          throw error;
        }

        return response.data.result;
      } catch (error) {
        const shouldRetry =
          isTransientRpcError(error) && attempt < this.config.maxRetries;
        if (!shouldRetry) {
          logger.error(`Bitcoin RPC error (${method}):`, error.message);
          throw error;
        }
        const delay = this.config.retryDelay * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async getBlocksWindow(
    startHeight,
    endHeight,
    concurrency = this.config.maxParallelRequests
  ) {
    const heights = Array.from(
      { length: endHeight - startHeight + 1 },
      (_, index) => startHeight + index
    );
    const results = new Array(heights.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= heights.length) return;
        const height = heights[index];
        const hash = await this.call("getblockhash", [height]);
        const block = await this.call("getblock", [hash, 2]);
        results[index] = { height, hash, block };
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(concurrency, heights.length)) },
        worker
      )
    );
    return results;
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
        logger.error("Failed to get transaction:", fallbackError);
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
}

// Export singleton instance
module.exports = new BitcoinRPC();
module.exports.BitcoinRPC = BitcoinRPC;
module.exports.isTransientRpcError = isTransientRpcError;
