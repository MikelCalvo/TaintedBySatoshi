const { Level } = require("level");
const path = require("path");
const defaultLogger = require("../utils/logger");

class DatabaseService {
  constructor(options = {}) {
    this.db = null;
    this.opening = null;
    this.dbPath =
      options.dbPath ||
      process.env.DB_PATH ||
      path.join(__dirname, "../../data");
    this.createDatabase =
      options.createDatabase ||
      ((dbPath) =>
        new Level(dbPath, {
          valueEncoding: "json",
          createIfMissing: true,
        }));
    this.ensureDirectory =
      options.ensureDirectory ||
      ((dbPath) => {
        const fs = require("fs");
        if (!fs.existsSync(dbPath)) {
          fs.mkdirSync(dbPath, { recursive: true });
        }
      });
    this.logger = options.logger || defaultLogger;
  }

  async init() {
    if (this.db?.status === "open") {
      return this.db;
    }

    if (this.opening) {
      return this.opening;
    }

    this.opening = (async () => {
      try {
        this.ensureDirectory(this.dbPath);
        if (!this.db || this.db.status === "closed") {
          this.db = this.createDatabase(this.dbPath);
        }
        if (this.db.status !== "open") {
          await this.db.open();
        }
        this.logger.info(`Database initialized at: ${this.dbPath}`);
        return this.db;
      } catch (error) {
        this.db = null;
        throw error;
      } finally {
        this.opening = null;
      }
    })();

    return this.opening;
  }

  async close() {
    if (this.opening) {
      await this.opening;
    }
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
    try {
      return await this.db.get(`tainted:${address}`);
    } catch (err) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }

  async updateTaintedInfo(address, taintedInfo) {
    await this.db.put(`tainted:${address}`, taintedInfo);
  }

  async getTransaction(txHash) {
    try {
      return await this.db.get(`tx:${txHash}`);
    } catch (err) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null;
      }
      throw err;
    }
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

  async getDatabaseStatus() {
    try {
      return await this.db.get("db:status");
    } catch (err) {
      return {
        lastUpdate: null,
        isUpdating: false,
      };
    }
  }
}

module.exports = new DatabaseService();
module.exports.DatabaseService = DatabaseService;
