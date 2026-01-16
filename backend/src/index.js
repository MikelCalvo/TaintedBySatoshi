require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { checkAddressConnection } = require("./services/bitcoinService");
const backgroundSyncService = require("./services/backgroundSyncService");
const analyticsService = require("./services/analyticsService");
const { validateAndSanitizeAddress } = require("./utils/validation");
const logger = require("./utils/logger");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const isDevelopment = process.env.NODE_ENV === "development";

// Trust proxy (nginx, cloudflare, etc.) for correct IP detection in rate limiting
app.set("trust proxy", 1);

// Security headers with helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: isDevelopment ? null : [],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Rate limiting - general API
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per windowMs
  message: {
    error: "Too many requests",
    message: "Please try again later",
    retryAfter: "15 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Exclude lightweight status endpoints from rate limiting
    return req.path === "/api/sync-status" ||
           req.path === "/api/health" ||
           req.path === "/api/analytics/stats";
  },
});

// Stricter rate limiting for address check endpoint
const addressCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: {
    error: "Too many address check requests",
    message: "Please wait before checking more addresses",
    retryAfter: "1 minute",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for analytics tracking (more permissive)
const analyticsTrackLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { error: "Too many tracking requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiter to all routes
app.use(generalLimiter);

// CORS configuration
const allowedOrigins = [process.env.FRONTEND_URL].filter(Boolean);
if (isDevelopment) {
  allowedOrigins.push("http://localhost:1337", "http://localhost:3000");
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, health checks) only in development
      if (!origin && isDevelopment) {
        return callback(null, true);
      }

      // In production, silently reject requests without origin (no error logging)
      if (!origin) {
        return callback(null, false);
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  })
);

// Limit JSON body size to prevent abuse
app.use(express.json({ limit: "10kb" }));

// Ensure data directory exists
const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  try {
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error("Health check failed", { error: error.message });
    res.status(500).json({
      status: "unhealthy",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});

// Add error handling middleware
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// Sync status endpoint
app.get("/api/sync-status", (req, res) => {
  try {
    const status = backgroundSyncService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error("Error getting sync status", { error: error.message });
    res.status(500).json({
      error: "Failed to get sync status",
      message:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});

// === ANALYTICS ENDPOINTS ===

// Track page views and events
app.post("/api/analytics/track", analyticsTrackLimiter, async (req, res) => {
  try {
    // Validate request body exists and is an object
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const { type, path, referrer } = req.body;

    // Basic type validation (detailed sanitization happens in service)
    if (path !== undefined && typeof path !== "string") {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (referrer !== undefined && typeof referrer !== "string") {
      return res.status(400).json({ error: "Invalid referrer" });
    }
    if (type !== undefined && typeof type !== "string") {
      return res.status(400).json({ error: "Invalid type" });
    }

    // Reject oversized payloads (defense in depth)
    if ((path && path.length > 2000) || (referrer && referrer.length > 2000)) {
      return res.status(400).json({ error: "Payload too large" });
    }

    // Get IP safely (considering proxy)
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;

    await analyticsService.trackEvent({
      type: type || "pageview",
      path,
      referrer,
      userAgent: req.headers["user-agent"],
      ip,
    });

    res.status(204).send(); // No content - fast response
  } catch (error) {
    logger.error("Analytics track error", { error: error.message });
    res.status(500).json({ error: "Failed to track event" });
  }
});

// Get public analytics stats (excluded from rate limiting like sync-status)
app.get("/api/analytics/stats", async (req, res) => {
  try {
    // Validate days parameter
    let days = parseInt(req.query.days);
    if (isNaN(days) || days < 1) {
      days = 30;
    }
    // Max limit enforced in service, but add sanity check here too
    if (days > 100000) {
      days = 36500;
    }

    const stats = await analyticsService.getStats({ days });

    if (!stats || stats.enabled === false) {
      return res.json({
        error: "Analytics disabled",
        enabled: false,
      });
    }

    res.json(stats);
  } catch (error) {
    logger.error("Analytics stats error", { error: error.message });
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Analytics service status
app.get("/api/analytics/status", async (req, res) => {
  try {
    const status = await analyticsService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: "Failed to get analytics status" });
  }
});

// Check if an address is connected to Satoshi
app.get("/api/check/:address", addressCheckLimiter, async (req, res) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const { address } = req.params;

    // Validate and sanitize the address
    const sanitizedAddress = validateAndSanitizeAddress(address);

    if (!sanitizedAddress) {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: "Invalid Bitcoin address",
        message: "Please provide a valid Bitcoin address (Legacy, P2SH, or Bech32 format)",
      });
    }

    const result = await checkAddressConnection(sanitizedAddress);

    clearTimeout(timeoutId);
    res.json(result);
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error("Error checking address", { error: error.message });

    if (error.name === "AbortError") {
      return res.status(503).json({
        error: "Service Temporarily Unavailable",
        message:
          "The request is taking longer than expected. Please try again in a few minutes.",
      });
    }

    res.status(500).json({
      error: "Failed to check address connection",
      message:
        "The server encountered an error while processing your request. Please try again.",
    });
  }
});

// Global error handlers to prevent PM2 restarts
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  if (error.code === 'EADDRINUSE') {
    logger.error('Port already in use, exiting');
    process.exit(1);
  }
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/api/health`);
  logger.info(`Sync status: http://localhost:${PORT}/api/sync-status`);

  // Start background sync service in next tick to avoid blocking
  setImmediate(async () => {
    try {
      logger.info("Starting background sync service...");
      await backgroundSyncService.start();
    } catch (error) {
      logger.error("Failed to start background sync service", { error: error.message });
    }
  });

  // Start analytics service
  setImmediate(async () => {
    try {
      await analyticsService.init();
      logger.info("Analytics service initialized");
    } catch (error) {
      logger.error("Failed to start analytics service", { error: error.message });
    }
  });
});
