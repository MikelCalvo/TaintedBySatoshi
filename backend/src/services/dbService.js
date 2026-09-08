const { Level } = require("level");
const path = require("path");
const defaultLogger = require("../utils/logger");

function boundedCacheBytes(value) {
  const parsed = Number.parseInt(value, 10);
  const megabytes = Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, 16), 512)
    : 128;
  return megabytes * 1024 * 1024;
}

class DatabaseService {
  constructor(options = {}) {
    this.db = null;
    this.opening = null;
    this.dbPath =
      options.dbPath ||
      process.env.DB_PATH ||
      path.join(__dirname, "../../data");
    this.environment = options.environment || process.env;
    this.databaseOptions = {
      valueEncoding: "json",
      createIfMissing: true,
      cacheSize: boundedCacheBytes(this.environment.LEVELDB_CACHE_MB),
    };
    this.createDatabase =
      options.createDatabase ||
      ((dbPath, databaseOptions) => new Level(dbPath, databaseOptions));
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
          this.db = this.createDatabase(this.dbPath, this.databaseOptions);
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

  async getTaintedInfo(address) {
    try {
      return await this.db.get(`a:${address}`);
    } catch (err) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }

  async updateTaintedInfo(address, taintedInfo) {
    await this.db.put(`a:${address}`, taintedInfo);
  }

  async getLiveOutpoint(outpoint) {
    try {
      return await this.db.get(`u:${outpoint}`);
    } catch (err) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }
}

module.exports = new DatabaseService();
module.exports.DatabaseService = DatabaseService;
