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
const FETCH_TIMEOUT = 300000; // 5 minutes
const BLOCK_FETCH_TIMEOUT = 600000; // 10 minutes for initial block fetch
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 30000; // 30 seconds

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

// Statistics tracking
const scanStats = {
  totalTainted: 0,
  degree1: 0,
  degree2: 0,
  degree3plus: 0,
  newInThisScan: 0,
};

// Batch configuration
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 1000;
const BATCH_FLUSH_INTERVAL = parseInt(process.env.BATCH_FLUSH_INTERVAL) || 5000;

async function processAddress(
  address,
  currentDegree,
  db,
  transaction,
  sourceAddress = null,
  batchContext = null
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

    // Store the transaction if not already stored
    const txKey = `tx:${tx.hash}`;
    let txExists = false;
    try {
      await db.get(txKey);
      txExists = true;
    } catch (err) {
      txExists = false;
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

    // Use batch if available, otherwise write individually
    if (batchContext && batchContext.batch) {
      // Add to batch
      if (!txExists) {
        batchContext.batch.put(txKey, {
          hash: tx.hash,
          time: tx.time,
          inputs: tx.inputs,
          outputs: tx.out,
          degree: currentDegree,
        });
        batchContext.count++;
      }
      batchContext.batch.put(`tainted:${address}`, taintData);
      batchContext.count++;

      // Flush batch if it reaches size limit or time limit
      if (batchContext.count >= BATCH_SIZE || 
          (Date.now() - batchContext.lastFlush) >= BATCH_FLUSH_INTERVAL) {
        await batchContext.batch.write();
        batchContext.batch = db.batch();
        batchContext.count = 0;
        batchContext.lastFlush = Date.now();
      }
    } else {
      // Fallback to individual writes (for backward compatibility)
      if (!txExists) {
        await db.put(txKey, {
          hash: tx.hash,
          time: tx.time,
          inputs: tx.inputs,
          outputs: tx.out,
          degree: currentDegree,
        });
      }
      await db.put(`tainted:${address}`, taintData);
    }

    // Update statistics
    scanStats.totalTainted++;
    scanStats.newInThisScan++;
    if (currentDegree === 1) scanStats.degree1++;
    else if (currentDegree === 2) scanStats.degree2++;
    else if (currentDegree >= 3) scanStats.degree3plus++;

    // Update cache
    if (parentTaintingCache.size <= 10000) {
      parentTaintingCache.set(address, taintData);
    }
  } catch (error) {
    console.error(`Error processing address ${address}:`, error);
  }
}

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  blue: "\x1b[34m",
  brightBlue: "\x1b[94m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  brightWhite: "\x1b[97m",
};

// Add these helper functions at the top level
function clearLines(count) {
  process.stdout.write(`\x1b[${count}A\x1b[0J`);
}

// Progress bar generator
function createProgressBar(percentage, width = 40) {
  const filled = Math.floor((percentage / 100) * width);
  const empty = width - filled;

  // Use block characters for smooth gradient
  const blocks = ["█", "▓", "▒", "░"];
  let bar = colors.brightCyan + "█".repeat(filled) + colors.reset;
  bar += colors.gray + "░".repeat(empty) + colors.reset;

  return bar;
}

// Compact number formatter
function compactNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

// Performance tracking with smoothing
let lastBlockTime = Date.now();
let lastBlock = 0;
let blocksPerSecond = 0;
let speedHistory = [];
const SPEED_HISTORY_SIZE = 10; // Average over last 10 measurements
let updateCounter = 0;
const UPDATE_INTERVAL = 5; // Update speed every 5 blocks
let isFirstUpdate = true; // Track first update to avoid clearing node status

function updateProgress(currentBlock, totalBlocks, overallProgress, stats) {
  updateCounter++;

  // Calculate speed every UPDATE_INTERVAL blocks for stability
  if (updateCounter >= UPDATE_INTERVAL) {
    const now = Date.now();
    const timeDiff = (now - lastBlockTime) / 1000;

    if (timeDiff > 0 && currentBlock > lastBlock) {
      const instantSpeed = (currentBlock - lastBlock) / timeDiff;

      // Add to history
      speedHistory.push(instantSpeed);
      if (speedHistory.length > SPEED_HISTORY_SIZE) {
        speedHistory.shift(); // Remove oldest
      }

      // Calculate average speed
      const avgSpeed =
        speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;
      blocksPerSecond = avgSpeed.toFixed(1);
    }

    lastBlockTime = now;
    lastBlock = currentBlock;
    updateCounter = 0;
  }

  // Calculate ETA
  const blocksRemaining = totalBlocks - currentBlock;
  const secondsRemaining =
    blocksPerSecond > 0 ? blocksRemaining / parseFloat(blocksPerSecond) : 0;
  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  const eta = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  // Clear previous display (skip on first update to preserve node status)
  const TABLE_LINES = 11;
  if (!isFirstUpdate) {
    clearLines(TABLE_LINES);
  }
  isFirstUpdate = false;

  // Create visual progress bar
  const progressBar = createProgressBar(overallProgress);

  // Build the minimal futuristic display
  const display = [
    "",
    colors.brightMagenta + "⚡ BLOCKCHAIN SCANNER" + colors.reset,
    "",
    progressBar +
      "  " +
      colors.brightYellow +
      overallProgress.toFixed(2) +
      "%" +
      colors.reset,
    colors.gray +
      "Block " +
      colors.reset +
      colors.brightWhite +
      currentBlock.toLocaleString() +
      colors.gray +
      " / " +
      colors.white +
      totalBlocks.toLocaleString() +
      colors.reset +
      "  " +
      colors.green +
      "⚡ " +
      blocksPerSecond +
      " bl/s" +
      colors.reset +
      "  " +
      colors.yellow +
      "⏱  " +
      eta +
      colors.reset,
    "",
    colors.brightGreen +
      "⬢ TAINTED: " +
      colors.brightWhite +
      stats.totalTainted.toLocaleString() +
      colors.reset +
      colors.gray +
      "  (+" +
      colors.brightGreen +
      stats.newInThisScan.toLocaleString() +
      colors.gray +
      " new)" +
      colors.reset,
    colors.cyan +
      "  ◆ Degree 1: " +
      colors.white +
      stats.degree1.toLocaleString() +
      colors.reset,
    colors.magenta +
      "  ◆ Degree 2: " +
      colors.white +
      stats.degree2.toLocaleString() +
      colors.reset,
    colors.blue +
      "  ◆ Degree 3+: " +
      colors.white +
      stats.degree3plus.toLocaleString() +
      colors.reset,
    "",
  ].join("\n");

  console.log(display);
}

async function updateSatoshiTransactions() {
  let db;
  let currentDegree = 1;

  try {
    // Load Satoshi addresses (update global variable)
    const satoshiAddressesPath = path.join(
      __dirname,
      "../../data/satoshiAddresses.js"
    );
    let ADDRESS_METADATA = {};
    let showPatoshiInfo = false;

    // Check if addresses file exists
    if (!fs.existsSync(satoshiAddressesPath)) {
      showPatoshiInfo = true;
      console.log("\n⚠️  Patoshi addresses not found.");
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
      console.error(
        "\n❌ ERROR: satoshiAddresses.js exists but contains no addresses!"
      );
      console.log("   Please run: npm run extract-patoshi-addresses\n");
      process.exit(1);
    }

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

    // Initialize stats by counting existing tainted addresses in database
    console.log("Counting existing tainted addresses...");
    let existingCount = 0;
    let existingDegree1 = 0;
    let existingDegree2 = 0;
    let existingDegree3plus = 0;

    try {
      const iterator = db.iterator({
        gt: "tainted:",
        lt: "tainted:\xff",
      });

      for await (const [key, value] of iterator) {
        existingCount++;
        if (value.degree === 1) existingDegree1++;
        else if (value.degree === 2) existingDegree2++;
        else if (value.degree >= 3) existingDegree3plus++;
      }
    } catch (err) {
      console.error("Error counting existing addresses:", err);
    }

    console.log(`Found ${existingCount.toLocaleString()} existing tainted addresses`);

    // Initialize stats with existing counts
    scanStats.totalTainted = existingCount;
    scanStats.degree1 = existingDegree1;
    scanStats.degree2 = existingDegree2;
    scanStats.degree3plus = existingDegree3plus;
    scanStats.newInThisScan = 0;

    // Initialize Satoshi coinbase outputs as tainted in scan progress DB
    const scanDb = new Level(path.join(DB_PATH, "scan_progress"), {
      valueEncoding: "json",
      createIfMissing: true,
    });
    await scanDb.open();

    // Check if already initialized
    let needsInit = false;
    try {
      await scanDb.get("satoshi_coinbase_initialized");
    } catch (err) {
      needsInit = true;
    }

    if (needsInit) {
      showPatoshiInfo = true;
      console.log("\n🔍 Initializing Satoshi coinbase outputs as tainted...");
      console.log(
        `Using ${SATOSHI_ADDRESSES.length.toLocaleString()} Patoshi addresses`
      );
      console.log(`📚 Source: https://github.com/bensig/patoshi-addresses`);
      console.log(`   Patoshi Pattern Analysis by Sergio Demian Lerner`);
      console.log(
        `   https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/`
      );
      console.log("\nScanning Patoshi blocks to extract coinbase outputs...");
      const { PATOSHI_BLOCKS } = require("../data/patoshiBlocks");
      const coinbaseBatch = scanDb.batch();
      let initCount = 0;

      // Add genesis and early blocks
      const EARLY_BLOCKS = [0, 1, 2];
      const allBlocks = [...EARLY_BLOCKS, ...PATOSHI_BLOCKS];

      for (let i = 0; i < allBlocks.length; i++) {
        const height = allBlocks[i];

        if (i % 1000 === 0) {
          console.log(
            `  Progress: ${i}/${allBlocks.length} (${(
              (i / allBlocks.length) *
              100
            ).toFixed(1)}%)`
          );
        }

        try {
          const hash = await bitcoinRPC.call("getblockhash", [height]);
          const block = await bitcoinRPC.call("getblock", [hash, 2]);
          const coinbaseTx = block.tx[0];

          // Mark each coinbase output as tainted
          for (
            let voutIndex = 0;
            voutIndex < coinbaseTx.vout.length;
            voutIndex++
          ) {
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

      console.log(
        `✓ Initialized ${initCount} Satoshi coinbase outputs as tainted\n`
      );
    }

    await scanDb.close();

    // Single pass chronological scan
    // Add separator and buffer lines so node status stays visible above
    console.log("════════════════════════════════════════════════════════════");
    console.log();
    
    // Initialize batch context for processAddress
    const batchContext = {
      batch: db.batch(),
      count: 0,
      lastFlush: Date.now(),
    };

    await timeoutPromise(
      () =>
        bitcoinRPC.getAddressTransactions(
          SATOSHI_ADDRESSES,
          (currentBlock) => {
            const overallProgress = (currentBlock / totalBlocks) * 100;
            updateProgress(
              currentBlock,
              totalBlocks,
              overallProgress,
              scanStats
            );
          },
          async (address, transaction, degree, sourceAddress) => {
            await processAddress(
              address,
              degree,
              db,
              transaction,
              sourceAddress,
              batchContext
            );
          }
        ),
      BLOCK_FETCH_TIMEOUT * 10, // Very long timeout for the whole scan
      1
    );

    // Flush any remaining batch operations
    if (batchContext.count > 0) {
      await batchContext.batch.write();
      console.log("Final batch write completed");
    }

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
