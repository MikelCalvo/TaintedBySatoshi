require("dotenv").config();
const { Level } = require("level");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const path = require("path");
const bitcoinRPC = require("../services/bitcoinRPC");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "./data";
const MAX_DEGREE = parseInt(process.env.MAX_DEGREE) || 100;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 100;
const FETCH_TIMEOUT = 300000; // 5 minutes
const BLOCK_FETCH_TIMEOUT = 600000; // 10 minutes for initial block fetch
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 30000; // 30 seconds
const PROGRESS_TABLE_LINES = 6;

// Load Satoshi addresses if available (needed by processAddress)
let SATOSHI_ADDRESSES = [];
try {
  const satoshiData = require("../../data/satoshiAddresses");
  SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
} catch (err) {
  // File doesn't exist yet - will be loaded later in updateSatoshiTransactions
}

// Ensure the database directory exists
const dataDir = path.join(
  process.env.DB_PATH || path.join(__dirname, "../../data")
);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Worker thread for processing addresses
if (!isMainThread) {
  const { address, currentDegree } = workerData;
  processAddress(address, currentDegree)
    .then((result) => parentPort.postMessage({ success: true, result }))
    .catch((error) =>
      parentPort.postMessage({ success: false, error: error.message })
    );
}

// Modify the timeoutPromise function
async function timeoutPromise(
  promiseFn,
  ms = FETCH_TIMEOUT,
  retries = RETRY_ATTEMPTS
) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), ms);

      const result = await Promise.race([
        promiseFn(),
        new Promise((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => {
            reject(new Error(`Operation timed out after ${ms}ms`));
          });
        }),
      ]);

      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      lastError = error;
      const isTimeout = error.message.includes("timed out");

      console.log(
        `Attempt ${attempt}/${retries} failed: ${error.message}\n` +
          `Error type: ${isTimeout ? "Timeout" : "Other"}`
      );

      if (attempt === retries) {
        throw new Error(
          `All ${retries} attempts failed. Last error: ${lastError.message}`
        );
      }

      // Exponential backoff with jitter
      const baseDelay = RETRY_DELAY * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 1000; // Add up to 1 second of random jitter
      const delay = Math.min(baseDelay + jitter, 120000); // Cap at 2 minutes

      console.log(
        `Waiting ${Math.round(delay / 1000)} seconds before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Cache for parent taintings to avoid repeated DB reads
const parentTaintingCache = new Map();

async function processAddress(
  address,
  currentDegree,
  db,
  transaction,
  sourceAddress = null
) {
  try {
    const tx = transaction;

    // Check if we already have a shorter path for this address
    try {
      const existing = await db.get(`tainted:${address}`);
      if (existing.degree <= currentDegree) {
        return; // Skip if we already have a shorter or equal path
      }
    } catch (err) {
      // Address not yet tainted, proceed
    }

    let path = [];
    let originalSatoshiAddress = address;

    if (sourceAddress) {
      // Try cache first, then DB
      let parentTinting = parentTaintingCache.get(sourceAddress);
      if (!parentTinting) {
        try {
          parentTinting = await db.get(`tainted:${sourceAddress}`);
          // Cache it for future use (limit cache size)
          if (parentTaintingCache.size > 10000) {
            const firstKey = parentTaintingCache.keys().next().value;
            parentTaintingCache.delete(firstKey);
          }
          parentTaintingCache.set(sourceAddress, parentTinting);
        } catch (err) {
          // Parent not found (shouldn't happen with chronological scan)
        }
      }

      if (parentTinting) {
        originalSatoshiAddress = parentTinting.originalSatoshiAddress;

        // Find the specific output amount for this address in the transaction
        const output = tx.out.find((o) => o.addr === address);
        const amount = output ? output.value : 0;

        path = [
          ...parentTinting.path,
          {
            from: sourceAddress,
            to: address,
            txHash: tx.hash,
            amount: amount,
          },
        ];
      }
    } else {
      // It's a Satoshi address (degree 0 or 1)
      if (SATOSHI_ADDRESSES && SATOSHI_ADDRESSES.includes(address)) {
        originalSatoshiAddress = address;
      }
    }

    // Store the transaction if not already stored (check cache first)
    const txKey = `tx:${tx.hash}`;
    try {
      await db.get(txKey);
    } catch (err) {
      await db.put(txKey, {
        hash: tx.hash,
        time: tx.time,
        inputs: tx.inputs,
        outputs: tx.out,
        degree: currentDegree,
      });
    }

    // Store tinting information
    const taintData = {
      txHash: tx.hash,
      originalSatoshiAddress,
      amount: tx.out.find((o) => o.addr === address)?.value || 0,
      degree: currentDegree,
      path,
      lastUpdated: Date.now(),
    };

    await db.put(`tainted:${address}`, taintData);

    // Update cache
    if (parentTaintingCache.size <= 10000) {
      parentTaintingCache.set(address, taintData);
    }
  } catch (error) {
    console.error(`Error processing address ${address}:`, error);
  }
}

// Add these helper functions at the top level
function clearLines(count) {
  process.stdout.write(`\x1b[${count}A\x1b[0J`);
}

function updateProgress(currentBlock, totalBlocks, overallProgress) {
  // Clear previous progress display
  clearLines(PROGRESS_TABLE_LINES);

  const progressTable = [
    "┌────────────────────────────────────────────────────┐",
    "│ Block Scan Progress                                │",
    "├────────────────────────────────────────────────────┤",
    `│ Current Block:     ${currentBlock
      .toLocaleString()
      .padEnd(10)} of ${totalBlocks.toLocaleString().padEnd(17)} │`,
    `│ Overall Progress:  ${overallProgress
      .toFixed(2)
      .padStart(7)}%                        │`,
    "└────────────────────────────────────────────────────┘",
  ].join("\n");

  console.log(progressTable);
}

async function updateSatoshiTransactions() {
  let db;
  let currentDegree = 1;

  try {
    console.log("Starting Satoshi transactions update...");

    // Load Satoshi addresses (update global variable)
    const satoshiAddressesPath = path.join(__dirname, "../../data/satoshiAddresses.js");
    let ADDRESS_METADATA = {};

    // Check if addresses file exists
    if (!fs.existsSync(satoshiAddressesPath)) {
      console.log(
        "\n⚠️  Patoshi addresses not found."
      );
      console.log(
        "📥 Extracting Patoshi addresses automatically (this may take 25-30 minutes)...\n"
      );

      const { extractPatoshiAddresses } = require("./extractPatoshiAddresses");
      const result = await extractPatoshiAddresses();

      console.log(`\n✅ Extracted ${result.count} addresses`);
      console.log(`✓ Continuing with blockchain scan...\n`);

      // Clear require cache so we can load the new file
      delete require.cache[require.resolve(satoshiAddressesPath)];
    }

    // Load the addresses (either existing or just created)
    const satoshiData = require(satoshiAddressesPath);
    SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
    ADDRESS_METADATA = satoshiData.ADDRESS_METADATA || {};

    // Verify we have addresses
    if (SATOSHI_ADDRESSES.length === 0) {
      console.error("\n❌ ERROR: satoshiAddresses.js exists but contains no addresses!");
      console.log("   Please run: npm run extract-patoshi-addresses\n");
      process.exit(1);
    }

    console.log(
      `Using ${SATOSHI_ADDRESSES.length.toLocaleString()} Patoshi addresses`
    );
    console.log(`📚 Source: https://github.com/bensig/patoshi-addresses`);
    console.log(`   Patoshi Pattern Analysis by Sergio Demian Lerner`);
    console.log(
      `   https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/\n`
    );

    await bitcoinRPC.initialize();

    // Get initial blockchain info
    const { blocks: totalBlocks } = await bitcoinRPC.getBlockchainInfo();

    db = new Level(DB_PATH, { valueEncoding: "json" });
    await db.open();
    console.log("Database connection established");

    // Initialize taint data for Satoshi addresses
    const taintedBatch = db.batch();
    for (const address of SATOSHI_ADDRESSES) {
      taintedBatch.put(`tainted:${address}`, {
        txHash: null,
        originalSatoshiAddress: address,
        amount: 0, // Will be updated when processing transactions
        degree: 0,
        path: [],
        lastUpdated: Date.now(),
      });
    }
    await taintedBatch.write();
    console.log(`Initialized ${SATOSHI_ADDRESSES.length} Satoshi addresses in main DB`);

    // Initialize Satoshi coinbase outputs as tainted in scan progress DB
    console.log("\n🔍 Initializing Satoshi coinbase outputs as tainted...");
    const scanDb = new Level(path.join(DB_PATH, "scan_progress"), {
      valueEncoding: "json",
      createIfMissing: true
    });
    await scanDb.open();

    // Check if already initialized
    let needsInit = false;
    try {
      await scanDb.get("satoshi_coinbase_initialized");
      console.log("✓ Satoshi coinbase outputs already initialized");
    } catch (err) {
      needsInit = true;
    }

    if (needsInit) {
      console.log("Scanning Patoshi blocks to extract coinbase outputs...");
      const { PATOSHI_BLOCKS } = require("../data/patoshiBlocks");
      const coinbaseBatch = scanDb.batch();
      let initCount = 0;

      // Add genesis and early blocks
      const EARLY_BLOCKS = [0, 1, 2];
      const allBlocks = [...EARLY_BLOCKS, ...PATOSHI_BLOCKS];

      for (let i = 0; i < allBlocks.length; i++) {
        const height = allBlocks[i];

        if (i % 1000 === 0) {
          console.log(`  Progress: ${i}/${allBlocks.length} (${((i/allBlocks.length)*100).toFixed(1)}%)`);
        }

        try {
          const hash = await bitcoinRPC.call("getblockhash", [height]);
          const block = await bitcoinRPC.call("getblock", [hash, 2]);
          const coinbaseTx = block.tx[0];

          // Mark each coinbase output as tainted
          for (let voutIndex = 0; voutIndex < coinbaseTx.vout.length; voutIndex++) {
            const vout = coinbaseTx.vout[voutIndex];
            const address = bitcoinRPC.getAddressFromScript(vout.scriptPubKey);
            const outpoint = `${coinbaseTx.txid}:${voutIndex}`;

            coinbaseBatch.put(`tainted_out:${outpoint}`, {
              address: address || null,
              degree: 0,
              txHash: coinbaseTx.txid,
              blockHeight: height,
            });
            initCount++;
          }
        } catch (error) {
          console.error(`Error processing block ${height}:`, error.message);
        }
      }

      await coinbaseBatch.write();
      await scanDb.put("satoshi_coinbase_initialized", {
        initialized: true,
        timestamp: Date.now(),
        count: initCount,
      });

      console.log(`✓ Initialized ${initCount} Satoshi coinbase outputs as tainted\n`);
    }

    await scanDb.close();

    // Single pass chronological scan
    console.log("Starting single-pass chronological scan...");
    await timeoutPromise(
      () =>
        bitcoinRPC.getAddressTransactions(
          SATOSHI_ADDRESSES,
          (currentBlock) => {
            const overallProgress = (currentBlock / totalBlocks) * 100;
            updateProgress(currentBlock, totalBlocks, overallProgress);
          },
          async (address, transaction, degree, sourceAddress) => {
            await processAddress(
              address,
              degree,
              db,
              transaction,
              sourceAddress
            );
          }
        ),
      BLOCK_FETCH_TIMEOUT * 10, // Very long timeout for the whole scan
      1
    );

    console.log("Successfully updated Satoshi transactions database");
  } catch (error) {
    console.error("\nError updating Satoshi transactions:", error);
    throw error;
  } finally {
    if (db) {
      try {
        await db.close();
        console.log("\nDatabase connection closed");
      } catch (error) {
        console.error("\nError closing database:", error);
      }
    }
  }
}

// If this script is run directly
if (require.main === module) {
  updateSatoshiTransactions()
    .then(() => {
      console.log("Update completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Update failed:", error);
      process.exit(1);
    });
}

module.exports = { updateSatoshiTransactions };
