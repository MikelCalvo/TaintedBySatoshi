require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { checkAddressConnection } = require("./services/bitcoinService");
const backgroundSyncService = require("./services/backgroundSyncService");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [process.env.FRONTEND_URL].filter(Boolean);

      if (process.env.NODE_ENV === "development") {
        allowedOrigins.push("http://localhost:1337");
      }

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  })
);
app.use(express.json());

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
app.get("/api/check/:address", async (req, res) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const { address } = req.params;

    if (!address || typeof address !== "string") {
      clearTimeout(timeoutId);
      return res.status(400).json({ error: "Invalid address parameter" });
    }

    const result = await checkAddressConnection(address);

    clearTimeout(timeoutId);
    res.json(result);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("Error checking address:", error);

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
