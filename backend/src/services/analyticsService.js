require("dotenv").config();
const { Level } = require("level");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

class AnalyticsService {
  constructor() {
    this.db = null;
    this.isRunning = false;

    // Batch management
    this.eventBatch = [];
    this.batchFlushInterval = null;
    this.lastBatchFlush = Date.now();

    // Configuration from environment
    // retentionDays: 0 = infinite retention (never delete old data)
    const retentionEnv = process.env.ANALYTICS_RETENTION_DAYS;
    this.config = {
      enabled: process.env.ANALYTICS_ENABLED !== "false",
      dbPath:
        process.env.ANALYTICS_DB_PATH ||
        path.join(__dirname, "../../data/analytics"),
      batchSize: parseInt(process.env.ANALYTICS_BATCH_SIZE) || 100,
      flushInterval: parseInt(process.env.ANALYTICS_FLUSH_INTERVAL) || 10000,
      retentionDays: retentionEnv === undefined ? 0 : parseInt(retentionEnv), // 0 = infinite
    };

    // Cache for stats (avoid frequent DB reads)
    this.statsCache = null;
    this.statsCacheExpiry = 0;
    this.statsCacheTTL = 60000; // 1 minute
  }

  async init() {
    if (this.db) return this.db;

    if (!this.config.enabled) {
      console.log("[Analytics] Service is disabled (ANALYTICS_ENABLED=false)");
      return null;
    }

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dbPath)) {
      fs.mkdirSync(this.config.dbPath, { recursive: true });
    }

    try {
      this.db = new Level(this.config.dbPath, {
        valueEncoding: "json",
        createIfMissing: true,
      });

      await this.db.open();
      console.log(`[Analytics] Database initialized at: ${this.config.dbPath}`);

      this.startBatchProcessor();
      this.isRunning = true;

      return this.db;
    } catch (error) {
      console.error("[Analytics] Failed to initialize database:", error.message);
      return null;
    }
  }

  // === TRACKING ===

  // Allowed event types (whitelist)
  static ALLOWED_TYPES = ["pageview", "click", "scroll", "error"];

  async trackEvent(eventData) {
    if (!this.config.enabled || !this.isRunning) return;

    // Validate and sanitize event type
    let type = "pageview";
    if (eventData.type && typeof eventData.type === "string") {
      const cleanType = eventData.type.toLowerCase().slice(0, 20);
      if (AnalyticsService.ALLOWED_TYPES.includes(cleanType)) {
        type = cleanType;
      }
    }

    const event = {
      type,
      path: this.sanitizePath(eventData.path),
      referrer: this.sanitizeReferrer(eventData.referrer),
      userAgent: this.categorizeUserAgent(eventData.userAgent),
      visitorId: this.generateVisitorId(eventData),
      timestamp: Date.now(),
    };

    this.eventBatch.push(event);

    // Flush if batch is full
    if (this.eventBatch.length >= this.config.batchSize) {
      await this.flushBatch();
    }
  }

  // === PRIVACY ===

  generateVisitorId(eventData) {
    // Anonymous hash: partial IP + UA + date (expires daily)
    const today = new Date().toISOString().split("T")[0];
    const partialIp = eventData.ip
      ? eventData.ip.split(".").slice(0, 2).join(".")
      : "unknown";
    const raw = `${partialIp}-${eventData.userAgent || "unknown"}-${today}`;
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  sanitizePath(urlPath) {
    if (!urlPath || typeof urlPath !== "string") return "/";

    // Remove query params and hash
    let clean = urlPath.split("?")[0].split("#")[0];

    // Remove control characters and normalize
    clean = clean.replace(/[\x00-\x1f\x7f]/g, "");

    // Prevent prototype pollution - block dangerous keys
    const dangerous = ["__proto__", "constructor", "prototype"];
    if (dangerous.some(d => clean.toLowerCase().includes(d))) {
      return "/invalid";
    }

    // Normalize and limit length
    return clean.toLowerCase().slice(0, 200);
  }

  sanitizeReferrer(referrer) {
    if (!referrer || typeof referrer !== "string") return "direct";

    // Limit input length before parsing
    if (referrer.length > 2000) return "invalid";

    try {
      const url = new URL(referrer);
      let hostname = url.hostname.slice(0, 100);

      // Prevent prototype pollution
      const dangerous = ["__proto__", "constructor", "prototype"];
      if (dangerous.some(d => hostname.toLowerCase().includes(d))) {
        return "invalid";
      }

      return hostname;
    } catch {
      return "invalid";
    }
  }

  categorizeUserAgent(ua) {
    if (!ua || typeof ua !== "string") return "unknown";

    // Limit length to prevent ReDoS
    const truncated = ua.slice(0, 500).toLowerCase();

    if (/bot|crawler|spider|scraper|curl|wget/i.test(truncated)) return "bot";
    if (/mobile|android|iphone|ipad|ipod/i.test(truncated)) return "mobile";
    return "desktop";
  }

  // === BATCH PROCESSING ===

  startBatchProcessor() {
    this.batchFlushInterval = setInterval(async () => {
      if (this.eventBatch.length > 0) {
        await this.flushBatch();
      }
    }, this.config.flushInterval);
  }

  async flushBatch() {
    if (this.eventBatch.length === 0) return;

    const eventsToProcess = [...this.eventBatch];
    this.eventBatch = [];

    try {
      await this.processEvents(eventsToProcess);
      this.lastBatchFlush = Date.now();
      // Invalidate cache
      this.statsCache = null;
      this.statsCacheExpiry = 0;
    } catch (error) {
      console.error("[Analytics] Error flushing batch:", error.message);
      // Only re-add events if batch isn't too large (prevent memory DoS)
      // Drop events if we're accumulating too many failures
      if (this.eventBatch.length < this.config.batchSize * 3) {
        this.eventBatch.unshift(...eventsToProcess);
      } else {
        console.warn("[Analytics] Dropping events due to repeated failures");
      }
    }
  }

  async processEvents(events) {
    const db = await this.init();
    if (!db) return;

    // Group events by day
    const dailyGroups = new Map();

    for (const event of events) {
      const day = new Date(event.timestamp).toISOString().split("T")[0];
      if (!dailyGroups.has(day)) {
        dailyGroups.set(day, []);
      }
      dailyGroups.get(day).push(event);
    }

    const batch = db.batch();
    let totalNewPageViews = 0;
    const allNewVisitors = new Set();

    for (const [day, dayEvents] of dailyGroups) {
      // Load existing data for this day
      let dayData;
      try {
        const existing = await db.get(`daily:${day}`);
        // Ensure all required fields exist (handles corrupted/incomplete data)
        dayData = {
          pageViews: existing?.pageViews || 0,
          uniqueVisitors: Array.isArray(existing?.uniqueVisitors) ? existing.uniqueVisitors : [],
          pages: existing?.pages || {},
          referrers: existing?.referrers || {},
          userAgents: existing?.userAgents || {},
        };
      } catch {
        dayData = {
          pageViews: 0,
          uniqueVisitors: [],
          pages: {},
          referrers: {},
          userAgents: {},
        };
      }

      const uniqueSet = new Set(dayData.uniqueVisitors);
      const previousVisitorCount = uniqueSet.size;

      for (const event of dayEvents) {
        dayData.pageViews++;
        totalNewPageViews++;

        uniqueSet.add(event.visitorId);

        dayData.pages[event.path] = (dayData.pages[event.path] || 0) + 1;
        dayData.referrers[event.referrer] =
          (dayData.referrers[event.referrer] || 0) + 1;
        dayData.userAgents[event.userAgent] =
          (dayData.userAgents[event.userAgent] || 0) + 1;
      }

      // Track truly new visitors
      if (uniqueSet.size > previousVisitorCount) {
        for (const visitor of uniqueSet) {
          if (!dayData.uniqueVisitors.includes(visitor)) {
            allNewVisitors.add(visitor);
          }
        }
      }

      dayData.uniqueVisitors = Array.from(uniqueSet);
      batch.put(`daily:${day}`, dayData);
    }

    // Update global totals
    let totals;
    try {
      const existing = await db.get("analytics:totals");
      // Ensure all required fields exist
      totals = {
        totalPageViews: existing?.totalPageViews || 0,
        totalUniqueVisitors: existing?.totalUniqueVisitors || 0,
        firstEventDate: existing?.firstEventDate || new Date().toISOString(),
      };
    } catch {
      totals = {
        totalPageViews: 0,
        totalUniqueVisitors: 0,
        firstEventDate: new Date().toISOString(),
      };
    }

    totals.totalPageViews += totalNewPageViews;
    totals.totalUniqueVisitors += allNewVisitors.size;
    totals.lastEventDate = new Date().toISOString();
    totals.lastUpdated = Date.now();

    batch.put("analytics:totals", totals);

    await batch.write();
  }

  // === STATISTICS ===

  // Maximum days to query (prevent DoS with huge ranges)
  static MAX_QUERY_DAYS = 36500; // ~100 years

  async getStats(options = {}) {
    // Check cache first
    if (this.statsCache && Date.now() < this.statsCacheExpiry) {
      return this.statsCache;
    }

    const db = await this.init();
    if (!db) {
      return { enabled: false, error: "Analytics disabled" };
    }

    // Validate and limit days parameter
    let days = parseInt(options.days) || 30;
    if (isNaN(days) || days < 1) days = 30;
    if (days > AnalyticsService.MAX_QUERY_DAYS) days = AnalyticsService.MAX_QUERY_DAYS;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    let totalPageViews = 0;
    const uniqueVisitors = new Set();
    const pages = {};
    const referrers = {};
    const userAgents = {};
    const dailyStats = [];

    // Iterate through days
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const day = d.toISOString().split("T")[0];

      try {
        const raw = await db.get(`daily:${day}`);

        // Ensure data structure is valid
        const dayData = {
          pageViews: raw?.pageViews || 0,
          uniqueVisitors: Array.isArray(raw?.uniqueVisitors) ? raw.uniqueVisitors : [],
          pages: raw?.pages || {},
          referrers: raw?.referrers || {},
          userAgents: raw?.userAgents || {},
        };

        totalPageViews += dayData.pageViews;
        dayData.uniqueVisitors.forEach((v) => uniqueVisitors.add(v));

        for (const [pagePath, count] of Object.entries(dayData.pages)) {
          pages[pagePath] = (pages[pagePath] || 0) + count;
        }

        for (const [ref, count] of Object.entries(dayData.referrers)) {
          referrers[ref] = (referrers[ref] || 0) + count;
        }

        for (const [ua, count] of Object.entries(dayData.userAgents)) {
          userAgents[ua] = (userAgents[ua] || 0) + count;
        }

        dailyStats.push({
          date: day,
          pageViews: dayData.pageViews,
          uniqueVisitors: dayData.uniqueVisitors.length,
        });
      } catch {
        // No data for this day
        dailyStats.push({ date: day, pageViews: 0, uniqueVisitors: 0 });
      }
    }

    // Sort top pages and referrers
    const topPages = Object.entries(pages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pagePath, views]) => ({ path: pagePath, views }));

    const topReferrers = Object.entries(referrers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([source, count]) => ({ source, count }));

    const stats = {
      summary: {
        totalPageViews,
        uniqueVisitors: uniqueVisitors.size,
        period: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          days,
        },
      },
      topPages,
      topReferrers,
      userAgents,
      dailyStats,
    };

    // Cache the result
    this.statsCache = stats;
    this.statsCacheExpiry = Date.now() + this.statsCacheTTL;

    return stats;
  }

  async getStatus() {
    return {
      isRunning: this.isRunning,
      enabled: this.config.enabled,
      pendingEvents: this.eventBatch.length,
      lastBatchFlush: this.lastBatchFlush,
      config: {
        batchSize: this.config.batchSize,
        flushInterval: this.config.flushInterval,
        retentionDays: this.config.retentionDays,
        dbPath: this.config.dbPath,
      },
    };
  }

  async stop() {
    if (this.batchFlushInterval) {
      clearInterval(this.batchFlushInterval);
      this.batchFlushInterval = null;
    }

    // Flush remaining events
    await this.flushBatch();

    if (this.db) {
      await this.db.close();
      this.db = null;
    }

    this.isRunning = false;
    console.log("[Analytics] Service stopped");
  }
}

// Export singleton instance
module.exports = new AnalyticsService();
