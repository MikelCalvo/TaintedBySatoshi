const dbService = require("./dbService");
const logger = require("../utils/logger");

let SATOSHI_ADDRESSES = [];
let SATOSHI_ADDRESS_SET = new Set();
let SATOSHI_NOTES = {};
try {
  const satoshiData = require("../../data/satoshiAddresses");
  SATOSHI_ADDRESSES = satoshiData.SATOSHI_ADDRESSES || [];
  SATOSHI_ADDRESS_SET = new Set(SATOSHI_ADDRESSES);
  SATOSHI_NOTES = satoshiData.SATOSHI_NOTES || {};
} catch (err) {
  logger.warn("Note: satoshiAddresses.js not found. Run initialization first.");
}

function hopEdge(from, to, record) {
  return {
    from,
    to,
    txHash: record.t,
    amount: record.n,
    hops: record.d,
  };
}

async function buildConnectionPath(db, address, taintedInfo, maxDepth = 10000) {
  if (!taintedInfo || !Number.isInteger(taintedInfo.d)) return [];

  const reversed = [];
  const visited = new Set([address]);
  let currentAddress = address;
  let current = taintedInfo;

  while (current && Number.isInteger(current.d) && current.d > 0 && current.p) {
    reversed.push(hopEdge(current.p, currentAddress, current));
    if (visited.has(current.p) || reversed.length > maxDepth) {
      throw new Error("Invalid taint parent chain");
    }
    visited.add(current.p);
    currentAddress = current.p;
    try {
      current = await db.get(`a:${currentAddress}`);
    } catch (error) {
      if (error.code === "LEVEL_NOT_FOUND") break;
      throw error;
    }
  }

  return reversed.reverse();
}

function publicWallet(address, record, extra = {}) {
  return {
    address,
    isConnected: true,
    isSatoshiAddress: SATOSHI_ADDRESS_SET.has(address),
    degree: record.d,
    hops: record.d,
    origin: record.o || null,
    parent: record.p || null,
    txHash: record.t || null,
    amount: record.n || 0,
    ...extra,
  };
}

async function checkAddressConnection(address) {
  try {
    const db = await dbService.init();

    if (SATOSHI_ADDRESS_SET.has(address)) {
      return {
        isConnected: true,
        isSatoshiAddress: true,
        degree: 0,
        hops: 0,
        origin: address,
        note: SATOSHI_NOTES[address] || "Known Satoshi address",
        connectionPath: [],
        transactions: [],
      };
    }

    const taintedInfo = await Promise.race([
      db.get(`a:${address}`).catch((error) => {
        if (error.code === "LEVEL_NOT_FOUND") return null;
        throw error;
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Database operation timeout")), 15000)
      ),
    ]);

    if (!taintedInfo) {
      return {
        isConnected: false,
        isSatoshiAddress: false,
        degree: 0,
        hops: 0,
        origin: null,
        connectionPath: [],
        transactions: [],
      };
    }

    const connectionPath = await buildConnectionPath(db, address, taintedInfo);
    return {
      isConnected: true,
      isSatoshiAddress: false,
      degree: taintedInfo.d,
      hops: taintedInfo.d,
      origin: taintedInfo.o || null,
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

async function listTaintedWallets({ limit = 50, cursor = null } = {}) {
  const db = await dbService.init();
  const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const wallets = [];
  const iterator = db.iterator({
    gt: cursor ? `a:${cursor}` : "a:",
    lt: "a:\xff",
    limit: pageSize,
  });

  for await (const [key, value] of iterator) {
    if (!key.startsWith("a:")) continue;
    wallets.push(publicWallet(key.slice(2), value));
  }

  return {
    wallets,
    nextCursor: wallets.length === pageSize ? wallets.at(-1).address : null,
  };
}

module.exports = {
  checkAddressConnection,
  buildConnectionPath,
  listTaintedWallets,
  SATOSHI_ADDRESSES,
};
