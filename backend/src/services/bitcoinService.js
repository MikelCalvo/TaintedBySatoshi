const dbService = require("./dbService");
const logger = require("../utils/logger");

// Load Satoshi addresses with error handling
let SATOSHI_ADDRESSES = [];
let SATOSHI_ADDRESS_SET = new Set();
let SATOSHI_NOTES = {};
try {
  const satoshiData = require("../../data/satoshiAddresses");
  SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
  SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
  SATOSHI_NOTES = satoshiData.SATOSHI_NOTES || {};
} catch (err) {
  // File doesn't exist yet - will be created by initialization
  logger.warn("Note: satoshiAddresses.js not found. Run initialization first.");
}

async function buildConnectionPath(db, address, taintedInfo, maxDepth = 10000) {
  if (Array.isArray(taintedInfo.path)) return taintedInfo.path;

  const reversed = [];
  const visited = new Set([address]);
  let current = taintedInfo;

  while (current?.edge) {
    reversed.push(current.edge);
    const parentAddress = current.parentAddress;
    if (!parentAddress) break;
    if (visited.has(parentAddress) || reversed.length > maxDepth) {
      throw new Error("Invalid taint parent chain");
    }
    visited.add(parentAddress);
    try {
      current = await db.get(`tainted:${parentAddress}`);
    } catch (error) {
      if (error.code === "LEVEL_NOT_FOUND") break;
      throw error;
    }

    if (Array.isArray(current?.path)) {
      return [...current.path, ...reversed.reverse()];
    }
  }

  return reversed.reverse();
}

async function checkAddressConnection(address) {
  let db = null;

  try {
    db = await dbService.init();

    // Quick check for Satoshi's addresses
    if (SATOSHI_ADDRESS_SET.has(address)) {
      return {
        isConnected: true,
        isSatoshiAddress: true,
        degree: 0,
        note: SATOSHI_NOTES[address] || "Known Satoshi address",
        connectionPath: [],
        transactions: [],
      };
    }

    // Add timeout for database operations
    const taintedInfo = await Promise.race([
      db.get(`tainted:${address}`).catch(() => null),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Database operation timeout")), 15000)
      ),
    ]);

    if (!taintedInfo) {
      return {
        isConnected: false,
        isSatoshiAddress: false,
        degree: 0,
        connectionPath: [],
        transactions: [],
      };
    }

    const connectionPath = await buildConnectionPath(db, address, taintedInfo);

    return {
      isConnected: true,
      isSatoshiAddress: false,
      degree: taintedInfo.degree,
      connectionPath,
      transactions: connectionPath.map((edge) => ({
        hash: edge.txHash,
        amount: edge.amount,
      })),
    };
  } catch (error) {
    logger.error("Database error:", error);
    throw error;
  }
}

module.exports = {
  checkAddressConnection,
  buildConnectionPath,
  SATOSHI_ADDRESSES,
};
