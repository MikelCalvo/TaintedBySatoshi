require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { checkAddressConnection } = require("./services/bitcoinService");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:1337",
        process.env.FRONTEND_URL,
      ].filter(Boolean); // Remove any undefined values

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
    maxAge: 86400, // 24 hours
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
  res.json({ status: "healthy" });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
