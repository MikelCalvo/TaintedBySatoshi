require("dotenv").config();
const { Level } = require("level");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const path = require("path");
const { SATOSHI_ADDRESSES } = require("../services/bitcoinService");
const bitcoinRPC = require("../services/bitcoinRPC");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "./data";
const MAX_DEGREE = parseInt(process.env.MAX_DEGREE) || 100;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 100;
const FETCH_TIMEOUT = 300000; // 5 minutes
const BLOCK_FETCH_TIMEOUT = 600000; // 10 minutes for initial block fetch
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 30000; // 30 seconds
const PROGRESS_TABLE_LINES = 7; // Number of lines in our progress table
const STATUS_UPDATE_LINES = 7; // Number of lines in the status update box

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

// Create a timeout wrapper function
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function processAddress(address, currentDegree, db) {
  if (!db) {
    db = new Level(DB_PATH, { valueEncoding: "json" });
  }

  try {
    const transactions = await bitcoinRPC.getAddressTransactions(address);

    for (const tx of transactions) {
      const isOutgoing = tx.inputs.some(
        (input) => input.prev_out.addr === address
      );

      if (isOutgoing) {
        // Store the transaction
        await db.put(`tx:${tx.hash}`, {
          hash: tx.hash,
          time: tx.time,
          inputs: tx.inputs,
          outputs: tx.out,
          fromAddress: address,
          degree: currentDegree,
        });

        // Process each output address in parallel
        const outputPromises = tx.out
          .filter(
            (output) =>
              output.addr !== address &&
              !SATOSHI_ADDRESSES.includes(output.addr)
          )
          .map(async (output) => {
            try {
              // Check if we already have a shorter path
              try {
                const existing = await db.get(`tainted:${output.addr}`);
                if (existing.degree <= currentDegree) {
                  return null; // Skip if we already have a shorter or equal path
                }
              } catch (err) {
                // Address not yet tainted, proceed with new path
              }

              const parentTinting = await db.get(`tainted:${address}`);
              const path = [
                ...parentTinting.path,
                {
                  from: address,
                  to: output.addr,
                  txHash: tx.hash,
                  amount: output.value,
                },
              ];

              // Store tinting information
              await db.put(`tainted:${output.addr}`, {
                txHash: tx.hash,
                originalSatoshiAddress: parentTinting.originalSatoshiAddress,
                amount: output.value,
                degree: currentDegree,
                path,
                lastUpdated: Date.now(),
              });

              return {
                address: output.addr,
                degree: currentDegree + 1,
              };
            } catch (err) {
              console.error(
                `Error processing output address ${output.addr}:`,
                err
              );
              return null;
            }
          });

        const results = await Promise.all(outputPromises);
        const nextAddresses = results.filter(Boolean);

        // Queue next degree addresses
        for (const { address: nextAddr, degree } of nextAddresses) {
          await db.put(`queue:${degree}:${nextAddr}`, {
            address: nextAddr,
            processed: false,
            queuedAt: Date.now(),
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error processing address ${address}:`, error);
    throw error;
  }
}

async function spawnWorker(address, currentDegree) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { address, currentDegree },
    });

    // Add timeout to kill hanging workers
    const workerTimeout = setTimeout(() => {
      console.error(`Worker for address ${address} timed out, terminating...`);
      worker.terminate();
      reject(new Error(`Worker timed out processing address ${address}`));
    }, FETCH_TIMEOUT);

    worker.on("message", (result) => {
      clearTimeout(workerTimeout);
      resolve(result);
    });

    worker.on("error", (error) => {
      clearTimeout(workerTimeout);
      reject(error);
    });

    worker.on("exit", (code) => {
      clearTimeout(workerTimeout);
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

async function processBatch(addresses, currentDegree) {
  const results = [];
  const failedAddresses = [];

  for (const address of addresses) {
    try {
      const result = await timeoutPromise(
        () => spawnWorker(address, currentDegree),
        FETCH_TIMEOUT,
        RETRY_ATTEMPTS
      );

      if (result.success) {
        results.push(result.result);
      } else {
        console.error(`Failed to process address ${address}: ${result.error}`);
        failedAddresses.push(address);
      }
    } catch (error) {
      console.error(`Failed to process address ${address}: ${error.message}`);
      failedAddresses.push(address);
    }
  }

  // If there are failed addresses, retry them once more with increased timeout
  if (failedAddresses.length > 0) {
    console.log(
      `Retrying ${failedAddresses.length} failed addresses with increased timeout...`
    );

    for (const address of failedAddresses) {
      try {
        const result = await timeoutPromise(
          () => spawnWorker(address, currentDegree),
          FETCH_TIMEOUT * 2, // Double the timeout for retries
          2 // Fewer retry attempts for already-failed addresses
        );

        if (result.success) {
          results.push(result.result);
        }
      } catch (error) {
        console.error(
          `Permanently failed to process address ${address}: ${error.message}`
        );
      }
    }
  }

  return results;
}

// Add these helper functions at the top level
function clearLines(count) {
  process.stdout.write(`\x1b[${count}A\x1b[0J`);
}

function updateProgress(
  currentBlock,
  totalBlocks,
  overallProgress,
  batchProgress
) {
  // Clear both progress displays (if they exist)
  clearLines(PROGRESS_TABLE_LINES + STATUS_UPDATE_LINES);

  const progressTable = [
    "┌────────────────────────────────────────────────────┐",
    "│ Progress Update                                    │",
    "├────────────────────────────────────────────────────┤",
    `│ Current Block:     ${currentBlock
      .toLocaleString()
      .padEnd(10)} of ${totalBlocks.toLocaleString().padEnd(10)} │`,
    `│ Overall Progress:  ${overallProgress
      .toFixed(2)
      .padStart(7)}%                        │`,
    `│ Batch Progress:    ${batchProgress
      .toFixed(2)
      .padStart(7)}%                        │`,
    "└────────────────────────────────────────────────────┘",
  ].join("\n");

  console.log(progressTable);
}

async function updateSatoshiTransactions() {
  let db;

  try {
    console.log("Starting Satoshi transactions update...");

    // Initialize Bitcoin RPC once
    await bitcoinRPC.initialize();

    // Initialize the database connection
    db = new Level(DB_PATH, { valueEncoding: "json" });
    console.log("Database connection established");

    // First degree: Direct transactions from Satoshi
    for (let i = 0; i < SATOSHI_ADDRESSES.length; i += BATCH_SIZE) {
      const batch = SATOSHI_ADDRESSES.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch of ${batch.length} Satoshi addresses...`);

      try {
        const transactionsByAddress = await timeoutPromise(
          () => bitcoinRPC.getAddressTransactions(batch),
          BLOCK_FETCH_TIMEOUT,
          5
        );

        for (const [address, transactions] of Object.entries(
          transactionsByAddress
        )) {
          if (!transactions || transactions.length === 0) {
            continue;
          }

          // Update progress display
          const currentBlock = transactions[0].block_height || 0;
          const totalBlocks = await bitcoinRPC.getBlockCount();
          const overallProgress = (currentBlock / totalBlocks) * 100;
          const batchProgress = (i / SATOSHI_ADDRESSES.length) * 100;

          updateProgress(
            currentBlock,
            totalBlocks,
            overallProgress,
            batchProgress
          );

          // Process transactions for each address
          for (const tx of transactions) {
            const isOutgoing = tx.inputs.some(
              (input) => input.prev_out.addr === address
            );

            if (isOutgoing) {
              // Store first-degree tainted addresses
              const outputPromises = tx.out
                .filter(
                  (output) =>
                    output.addr !== address &&
                    !SATOSHI_ADDRESSES.includes(output.addr)
                )
                .map(async (output) => {
                  await db.put(`tainted:${output.addr}`, {
                    txHash: tx.hash,
                    satoshiAddress: address,
                    originalSatoshiAddress: address,
                    amount: output.value,
                    degree: 1,
                    path: [
                      {
                        from: address,
                        to: output.addr,
                        txHash: tx.hash,
                        amount: output.value,
                      },
                    ],
                    lastUpdated: Date.now(),
                  });

                  return output.addr;
                });

              const taintedAddresses = await Promise.all(outputPromises);

              // Queue for next degree processing
              for (const addr of taintedAddresses) {
                await db.put(`queue:2:${addr}`, {
                  address: addr,
                  processed: false,
                  queuedAt: Date.now(),
                });
              }
            }
          }
        }
      } catch (error) {
        console.error("\nFailed to process batch:", error.message);
        if (error.message.includes("timeout")) {
          console.log("Attempting to resume from last saved progress...");
          continue;
        }
        throw error;
      }
    }

    // Process subsequent degrees using worker threads
    let currentDegree = 2;
    let hasMore = true;

    while (hasMore && currentDegree <= MAX_DEGREE) {
      console.log(`Processing degree ${currentDegree} connections...`);
      hasMore = false;

      // Get all addresses for current degree
      const addresses = [];
      const iterator = db.iterator({
        gt: `queue:${currentDegree}:`,
        lt: `queue:${currentDegree}:\xff`,
      });

      for await (const [key, value] of iterator) {
        if (!value.processed) {
          hasMore = true;
          addresses.push(value.address);
        }
      }

      if (addresses.length > 0) {
        // Process addresses in batches using worker threads
        for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
          const batch = addresses.slice(i, i + BATCH_SIZE);
          await processBatch(batch, currentDegree);

          // Mark addresses as processed
          for (const address of batch) {
            await db.put(`queue:${currentDegree}:${address}`, {
              address,
              processed: true,
              processedAt: Date.now(),
            });
          }
        }
      }

      if (hasMore) {
        currentDegree++;
      }
    }

    if (currentDegree > MAX_DEGREE) {
      console.log(`Reached maximum degree limit (${MAX_DEGREE})`);
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
