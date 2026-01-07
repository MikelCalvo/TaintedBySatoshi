require("dotenv").config();
const { Level } = require("level");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "./data";

async function checkSatoshiData() {
  console.log("🔍 Checking Satoshi Data Database...");
  console.log(`📂 Database Path: ${DB_PATH}`);

  if (!fs.existsSync(DB_PATH)) {
    console.error("❌ Database directory not found!");
    return;
  }

  const db = new Level(DB_PATH, { valueEncoding: "json" });

  try {
    await db.open();
    console.log("✅ Database connected successfully.\n");

    let stats = {
      tainted: 0,
      transactions: 0,
      queue: 0,
      other: 0,
      total: 0,
      maxDegree: 0
    };

    let recentTainted = [];

    console.log("📊 Scanning database entries...");

    for await (const [key, value] of db.iterator()) {
      stats.total++;

      if (key.startsWith("tainted:")) {
        stats.tainted++;
        if (value.degree > stats.maxDegree) {
          stats.maxDegree = value.degree;
        }

        // Track recent tainted addresses
        if (value.lastUpdated) {
          recentTainted.push({ key, value });
          // Keep only top 3 most recent to save memory
          if (recentTainted.length > 3) {
            recentTainted.sort((a, b) => b.value.lastUpdated - a.value.lastUpdated);
            recentTainted = recentTainted.slice(0, 3);
          }
        } else if (recentTainted.length < 3) {
             recentTainted.push({ key, value });
        }

      } else if (key.startsWith("tx:")) {
        stats.transactions++;
      } else if (key.startsWith("queue:")) {
        stats.queue++;
      } else {
        stats.other++;
      }
    }
    
    // Final sort to be sure
    recentTainted.sort((a, b) => (b.value.lastUpdated || 0) - (a.value.lastUpdated || 0));

    // Try to read scan progress
    let scanProgress = null;
    try {
        const scanDbPath = path.join(DB_PATH, "scan_progress");
        if (fs.existsSync(scanDbPath)) {
            const scanDb = new Level(scanDbPath, { valueEncoding: "json" });
            await scanDb.open();
            try {
                scanProgress = await scanDb.get("scan_progress");
            } catch(e) {}
            await scanDb.close();
        }
    } catch (e) {
        console.log("⚠️  Could not read scan progress (DB might be locked)");
    }

    console.log("\n📈 Statistics:");
    console.log("----------------------------------------");
    console.log(`Total Entries:      ${stats.total.toLocaleString()}`);
    console.log(`Tainted Addresses:  ${stats.tainted.toLocaleString()}`);
    console.log(`Transactions:       ${stats.transactions.toLocaleString()}`);
    console.log(`Queue Items:        ${stats.queue.toLocaleString()}`);
    console.log(`Other Keys:         ${stats.other.toLocaleString()}`);
    console.log(`Max Degree Found:   ${stats.maxDegree}`);
    if (scanProgress) {
        console.log(`Last Block Scanned: ${scanProgress.lastBlock?.toLocaleString() || 'Unknown'}`);
    }
    console.log("----------------------------------------");

    if (recentTainted.length > 0) {
      console.log("\n🕒 Most Recently Updated Tainted Addresses:");
      recentTainted.forEach(item => {
        const date = item.value.lastUpdated ? new Date(item.value.lastUpdated).toISOString() : 'N/A';
        console.log(`  - ${item.key.replace("tainted:", "")}`);
        console.log(`    Degree: ${item.value.degree}, Path Length: ${item.value.path?.length || 0}, Updated: ${date}`);
      });
    }

  } catch (error) {
    if (error.code === 'LEVEL_DATABASE_NOT_OPEN' || error.code === 'LEVEL_LOCKED') {
       console.error("❌ Error: Database is locked. Is the backend server or update script running? Please stop them before running this script.");
    } else {
       console.error("❌ Error reading database:", error);
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
