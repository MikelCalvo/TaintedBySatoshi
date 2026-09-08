require("dotenv").config();
const { Level } = require("level");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "./data";

async function checkSatoshiData() {
  console.log("Checking TaintedBySatoshi live UTXO database...");
  console.log(`Database path: ${DB_PATH}`);

  if (!fs.existsSync(DB_PATH)) {
    console.error("Database directory not found.");
    return;
  }

  const db = new Level(DB_PATH, { valueEncoding: "json" });

  try {
    await db.open();
    const stats = {
      wallets: 0,
      liveOutpoints: 0,
      other: 0,
      total: 0,
      maxHops: 0,
      byDegree: {},
    };

    let progress = null;
    for await (const [key, value] of db.iterator()) {
      stats.total++;
      if (key.startsWith("a:")) {
        stats.wallets++;
        const hops = Number.isInteger(value?.d) ? value.d : 0;
        stats.maxHops = Math.max(stats.maxHops, hops);
        stats.byDegree[hops] = (stats.byDegree[hops] || 0) + 1;
      } else if (key.startsWith("u:")) {
        stats.liveOutpoints++;
      } else if (key === "scan_progress") {
        progress = value;
      } else {
        stats.other++;
      }
    }

    console.log("\nStatistics:");
    console.log("----------------------------------------");
    console.log(`Total keys:         ${stats.total.toLocaleString()}`);
    console.log(`Tainted wallets:    ${stats.wallets.toLocaleString()}`);
    console.log(`Live tainted UTXOs: ${stats.liveOutpoints.toLocaleString()}`);
    console.log(`Other keys:         ${stats.other.toLocaleString()}`);
    console.log(`Max hops:           ${stats.maxHops}`);
    if (progress) {
      console.log(`Last block scanned: ${progress.lastBlock?.toLocaleString() || "Unknown"}`);
      console.log(`Schema version:     ${progress.schemaVersion ?? "unknown"}`);
    }
    console.log("Hops histogram:");
    for (const hops of Object.keys(stats.byDegree)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, 20)) {
      console.log(`  ${hops}: ${stats.byDegree[hops].toLocaleString()}`);
    }
    console.log("----------------------------------------");
  } catch (error) {
    if (error.code === "LEVEL_DATABASE_NOT_OPEN" || error.code === "LEVEL_LOCKED") {
      console.error("Database is locked. Stop the backend before running this script.");
    } else {
      console.error("Error reading database:", error);
    }
  } finally {
    try {
      await db.close();
    } catch (e) {}
  }
}

if (require.main === module) {
  checkSatoshiData();
}

module.exports = { checkSatoshiData };
