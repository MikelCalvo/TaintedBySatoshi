require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { checkAddressConnection } = require("./services/bitcoinService");
const backgroundSyncService = require("./services/backgroundSyncService");
const { validateAndSanitizeAddress } = require("./utils/validation");
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
    methods: ["GET", "OPTIONS"],
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
    console.error("Health check failed:", error);
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
  console.error(err.stack);
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
    console.error("Error getting sync status:", error);
    res.status(500).json({
      error: "Failed to get sync status",
      message:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
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
    console.error("Error checking address:", error.message);

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
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process - log and continue
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process - log and continue
  // Only exit on truly critical errors
  if (error.code === 'EADDRINUSE') {
    console.error('Port already in use. Exiting...');
    process.exit(1);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Sync status: http://localhost:${PORT}/api/sync-status`);

  // Start background sync service in next tick to avoid blocking
  setImmediate(async () => {
    try {
      console.log("Starting background sync service...");
      await backgroundSyncService.start();
    } catch (error) {
      console.error("Failed to start background sync service:", error.message);
      console.error(error.stack);
      // Don't exit - server can still serve requests without sync
    }
  });
});
