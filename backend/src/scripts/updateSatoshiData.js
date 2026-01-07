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
      try {
        const parentTinting = await db.get(`tainted:${sourceAddress}`);
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
      } catch (err) {
        // Parent not found (shouldn't happen with chronological scan)
      }
    } else {
      // It's a Satoshi address (degree 0 or 1)
      if (SATOSHI_ADDRESSES.includes(address)) {
        originalSatoshiAddress = address;
      }
    }

    // Store the transaction if not already stored
    try {
      await db.get(`tx:${tx.hash}`);
    } catch (err) {
      await db.put(`tx:${tx.hash}`, {
        hash: tx.hash,
        time: tx.time,
        inputs: tx.inputs,
        outputs: tx.out,
        degree: currentDegree,
      });
    }

    // Store tinting information
    await db.put(`tainted:${address}`, {
      txHash: tx.hash,
      originalSatoshiAddress,
      amount: tx.out.find((o) => o.addr === address)?.value || 0,
      degree: currentDegree,
      path,
      lastUpdated: Date.now(),
    });
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

    // Load Satoshi addresses
    const satoshiAddressesPath = path.join(__dirname, "../../data/satoshiAddresses.js");
    let SATOSHI_ADDRESSES = [];
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
    console.log("Database connection established");

    // Initialize taint data for Satoshi addresses
    for (const address of SATOSHI_ADDRESSES) {
      await db.put(`tainted:${address}`, {
        txHash: null,
        originalSatoshiAddress: address,
        amount: 0, // Will be updated when processing transactions
        degree: 0,
        path: [],
        lastUpdated: Date.now(),
      });
    }

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
