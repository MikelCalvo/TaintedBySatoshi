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
async function timeoutPromise(promiseFn, ms = FETCH_TIMEOUT, retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeoutError = new Error(`Timeout of ${ms}ms exceeded`);
      const result = await Promise.race([
        promiseFn(),
        new Promise((_, reject) => setTimeout(() => reject(timeoutError), ms)),
      ]);
      return result;
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt}/${retries} failed:`, error.message);

      if (attempt === retries) {
        throw lastError;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`Waiting ${delay / 1000} seconds before retry...`);
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

    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

async function processBatch(addresses, currentDegree) {
  const results = await Promise.all(
    addresses.map((address) => spawnWorker(address, currentDegree))
  );
  return results.filter((r) => r.success).map((r) => r.result);
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
          BLOCK_FETCH_TIMEOUT, // Use longer timeout for block fetching
          5 // More retries for initial scan
        );

        // Process transactions for each address
        for (const [address, transactions] of Object.entries(
          transactionsByAddress
        )) {
          if (!transactions || transactions.length === 0) {
            console.log(
              `No transactions found for address ${address}, skipping...`
            );
            continue;
          }

          console.log(
            `Processing ${transactions.length} transactions for ${address}`
          );

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
        console.error("Failed to process batch:", error.message);
        // Add recovery logic
        if (error.message.includes("timeout")) {
          console.log("Attempting to resume from last saved progress...");
          // The BitcoinRPC class will handle resuming from the last saved block
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
    console.error("Error updating Satoshi transactions:", error);
    throw error;
  } finally {
    if (db) {
      try {
        await db.close();
        console.log("Database connection closed");
      } catch (error) {
        console.error("Error closing database:", error);
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
