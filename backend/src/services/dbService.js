const { Level } = require("level");
const path = require("path");

class DatabaseService {
  constructor() {
    this.db = null;
    // Use environment variable for DB path or fall back to default
    const dbDir = process.env.DB_PATH || path.join(__dirname, "../../data");
    this.dbPath = path.join(dbDir, "satoshi-transactions");
  }

  async init() {
    if (!this.db) {
      // Ensure the directory exists
      const fs = require("fs");
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

      this.db = new Level(this.dbPath, {
        valueEncoding: "json",
      });
      // Wait for the database to be ready
      await new Promise((resolve, reject) => {
        this.db.once("ready", resolve);
        this.db.once("error", reject);
      });

      console.log(`Database initialized at: ${this.dbPath}`);
    }
    return this.db;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  async getLastProcessedBlock(address) {
    try {
      return await this.db.get(`lastBlock:${address}`);
    } catch (err) {
      return 0;
    }
  }

  async updateLastProcessedBlock(address, blockHeight) {
    await this.db.put(`lastBlock:${address}`, blockHeight);
  }

  async getTaintedInfo(address) {
    return await this.db.get(`tainted:${address}`);
  }

  async updateTaintedInfo(address, taintedInfo) {
    await this.db.put(`tainted:${address}`, taintedInfo);
  }

  async getTransaction(txHash) {
    return await this.db.get(`tx:${txHash}`);
  }

  async saveTransaction(txHash, txData) {
    await this.db.put(`tx:${txHash}`, txData);
  }

  async saveQueueItem(degree, address, data) {
    await this.db.put(`queue:${degree}:${address}`, data);
  }

  async getQueueIterator(degree) {
    return this.db.iterator({
      gt: `queue:${degree}:`,
      lt: `queue:${degree}:\xff`,
    });
  }
}

// Export singleton instance
module.exports = new DatabaseService();
