const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const dbService = require("../src/services/dbService");
const walletIndex = require("../src/services/walletIndexService");
const { listTaintedWallets } = require("../src/services/bitcoinService");
const { handleListWallets } = require("../src/handlers/wallets");
const { walletHopIndexKey: h } = require("../src/services/walletIndexKeys");
const { parseWalletListQuery } = require("../src/utils/validation");

const FIXTURE_COUNT = 321;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fixtureRecords() {
  return Array.from({ length: FIXTURE_COUNT }, (_, i) => ({
    address: `1${String(i).padStart(6, "0")}abc`,
    d: (320 - i) % 11,
  }));
}

function expectedMatching(records, { q = null, minHops = null, maxHops = null, sort }) {
  const reverse = sort.endsWith("desc") ? -1 : 1;
  return records
    .filter((record) => (q == null || record.address.startsWith(q))
      && (minHops == null || record.d >= minHops)
      && (maxHops == null || record.d <= maxHops))
    .sort((a, b) => reverse * (sort.startsWith("hops")
      ? (a.d - b.d || a.address.localeCompare(b.address))
      : a.address.localeCompare(b.address)));
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
    server.unref();
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestWallets(baseUrl, query) {
  const url = typeof query === "string"
    ? `${baseUrl}/api/wallets${query}`
    : `${baseUrl}/api/wallets?${new URLSearchParams(query)}`;
  const response = await fetch(url);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text when the server does not return JSON
  }
  return { status: response.status, headers: response.headers, body };
}

test.describe("GET /api/wallets HTTP contract", { concurrency: 1 }, () => {
  let baseUrl;
  let server;
  let tempDir;
  let records;
  const original = {};

  test.before(async () => {
    original.dbPath = dbService.dbPath;
    original.logger = dbService.logger;
    original.phase = walletIndex.phase;
    original.indexed = walletIndex.indexed;
    original.total = walletIndex.total;
    original.cursor = walletIndex.cursor;
    original.error = walletIndex.error;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "tbs-wallets-http-"));
    await dbService.close();
    dbService.dbPath = tempDir;
    dbService.logger = silentLogger;
    const db = await dbService.init();

    records = fixtureRecords().concat(
      [
        { address: "bc1qmatch1", d: 3 },
        { address: "BC1HIDDEN", d: 3 },
      ],
      Array.from({ length: 520 }, (_, i) => ({
        address: `3wide${String(i).padStart(4, "0")}`,
        d: i,
      }))
    );
    await db.batch(records.flatMap((record) => [
      {
        type: "put",
        key: `a:${record.address}`,
        value: { d: record.d, p: "seed", o: "seed", n: 1, t: "tx" },
      },
      { type: "put", key: h(record.address, record.d), value: 1 },
    ]));

    walletIndex.phase = "ready";
    walletIndex.indexed = records.length;
    walletIndex.total = records.length;
    walletIndex.cursor = null;
    walletIndex.error = null;

    const app = express();
    app.get("/api/wallets", handleListWallets({ listTaintedWallets, logger: silentLogger }));
    server = await listen(app);
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  test.after(async () => {
    try {
      if (server) await closeServer(server);
    } finally {
      walletIndex.phase = original.phase;
      walletIndex.indexed = original.indexed;
      walletIndex.total = original.total;
      walletIndex.cursor = original.cursor;
      walletIndex.error = original.error;
      dbService.logger = original.logger;
      await dbService.close();
      dbService.dbPath = original.dbPath;
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("hops-asc over more than 512 occupied degrees returns 200 not 422", async () => {
    const page = await requestWallets(baseUrl, { sort: "hops-asc", limit: "20" });
    assert.equal(page.status, 200);
    assert.equal(page.body.error, undefined);
    assert.equal(page.body.wallets.length, 20);
    assert.equal(page.body.hasMore, true);
    assert.equal(typeof page.body.nextCursor, "string");
    assert.notEqual(page.body.scanLimited, true);
    assert.equal(page.body.wallets[0].hops, 0);
    for (let i = 1; i < page.body.wallets.length; i += 1) {
      assert.ok(page.body.wallets[i].hops >= page.body.wallets[i - 1].hops);
    }
  });

  test("hops sort with min/max first page includes wallets beyond the initial 50 address rows", async () => {
    const page = await requestWallets(baseUrl, {
      sort: "hops-asc",
      minHops: "0",
      maxHops: "10",
      limit: "50",
    });
    assert.equal(page.status, 200);
    assert.equal(page.body.wallets.length, 50);
    assert.equal(page.body.hasMore, true);
    assert.equal(typeof page.body.nextCursor, "string");
    assert.ok(page.body.wallets.every((wallet) => wallet.hops >= 0 && wallet.hops <= 10));
    for (let i = 1; i < page.body.wallets.length; i += 1) {
      const previous = page.body.wallets[i - 1];
      const current = page.body.wallets[i];
      assert.ok(
        current.hops > previous.hops
          || (current.hops === previous.hops && current.address >= previous.address)
      );
    }
    const initialAddressPage = new Set(records.slice(0, 50).map((record) => record.address));
    assert.ok(page.body.wallets.some((wallet) => !initialAddressPage.has(wallet.address)));
  });

  test("address-desc plus hop range returns the globally filtered first page", async () => {
    const page = await requestWallets(baseUrl, {
      sort: "address-desc",
      minHops: "2",
      maxHops: "7",
      limit: "17",
    });
    const expected = expectedMatching(records, {
      sort: "address-desc",
      minHops: 2,
      maxHops: 7,
    });
    assert.equal(page.status, 200);
    assert.deepEqual(
      page.body.wallets.map((wallet) => wallet.address),
      expected.slice(0, 17).map((record) => record.address)
    );
    assert.ok(page.body.wallets.every((wallet) => wallet.hops >= 2 && wallet.hops <= 7));
    assert.equal(page.body.hasMore, true);
  });

  test("cursor follow keeps filters and the handler re-parses the raw cursor", async () => {
    const query = { sort: "hops-desc", q: "1", minHops: "2", maxHops: "7", limit: "17" };
    const found = [];
    let cursor = null;
    do {
      const page = await requestWallets(baseUrl, cursor ? { ...query, cursor } : query);
      assert.equal(page.status, 200);
      found.push(...page.body.wallets);
      if (page.body.nextCursor) {
        const decoded = parseWalletListQuery({ ...query, cursor: page.body.nextCursor });
        assert.equal(typeof decoded.cursor, "string");
        assert.notEqual(decoded.cursor, page.body.nextCursor);
        assert.match(decoded.cursor, /^h:\d{16}:/);
      }
      cursor = page.body.nextCursor;
    } while (cursor);

    const expected = expectedMatching(records, {
      q: "1",
      sort: "hops-desc",
      minHops: 2,
      maxHops: 7,
    });
    assert.deepEqual(found.map((wallet) => wallet.address), expected.map((record) => record.address));
    assert.equal(new Set(found.map((wallet) => wallet.address)).size, found.length);
    assert.ok(found.length > 50);
  });

  test("cursor from a different filter set returns 400", async () => {
    const first = await requestWallets(baseUrl, { sort: "hops-asc", limit: "2" });
    assert.equal(first.status, 200);
    const mismatched = await requestWallets(baseUrl, {
      sort: "hops-desc",
      limit: "2",
      cursor: first.body.nextCursor,
    });
    assert.equal(mismatched.status, 400);
    assert.match(mismatched.body.error, /invalid/i);
  });

  test("repeated query parameter arrays return 400", async () => {
    const repeatedQ = await requestWallets(baseUrl, "?q=100000&q=100001");
    assert.equal(repeatedQ.status, 400);
    assert.match(repeatedQ.body.error, /invalid/i);

    const repeatedSort = await requestWallets(baseUrl, "?sort=hops-asc&sort=hops-desc");
    assert.equal(repeatedSort.status, 400);
    assert.match(repeatedSort.body.error, /invalid/i);
  });

  test("address prefix matching is exact-case", async () => {
    const lower = await requestWallets(baseUrl, { q: "bc1", limit: "10" });
    assert.equal(lower.status, 200);
    assert.deepEqual(lower.body.wallets.map((wallet) => wallet.address), ["bc1qmatch1"]);

    const upper = await requestWallets(baseUrl, { q: "BC1", limit: "10" });
    assert.equal(upper.status, 200);
    assert.deepEqual(upper.body.wallets.map((wallet) => wallet.address), ["BC1HIDDEN"]);
  });

  test("hop queries return 503 with Retry-After while indexing; ordinary address search stays 200", async () => {
    walletIndex.phase = "backfilling";
    walletIndex.indexed = 40;
    walletIndex.total = FIXTURE_COUNT;
    walletIndex.cursor = "a:1000040abc";
    try {
      const building = await requestWallets(baseUrl, {
        sort: "hops-asc",
        minHops: "0",
        maxHops: "10",
        limit: "20",
      });
      assert.equal(building.status, 503);
      assert.equal(building.headers.get("retry-after"), "30");
      assert.equal(building.body.error, "WALLET_INDEX_BUILDING");
      assert.equal(building.body.retryAfter, 30);
      assert.match(building.body.message, /preparing/i);
      assert.deepEqual(building.body.index, {
        ready: false,
        phase: "backfilling",
        indexed: 40,
        total: FIXTURE_COUNT,
        cursor: "a:1000040abc",
        error: null,
      });
      assert.equal(building.body.wallets, undefined);

      const ordinary = await requestWallets(baseUrl, { q: "100000", sort: "address-asc", limit: "10" });
      assert.equal(ordinary.status, 200);
      assert.ok(ordinary.body.wallets.length > 0);
      assert.ok(ordinary.body.wallets.every((wallet) => wallet.address.startsWith("100000")));
    } finally {
      walletIndex.phase = "ready";
      walletIndex.indexed = FIXTURE_COUNT + 2;
      walletIndex.total = FIXTURE_COUNT + 2;
      walletIndex.cursor = null;
    }
  });

  test("atomic wallet hop update and index removal are visible on the next HTTP query", async () => {
    const target = records[100];
    const previousHops = target.d;
    const nextHops = previousHops === 10 ? 0 : previousHops + 1;
    const prefix = { q: target.address, limit: "5" };

    const before = await requestWallets(baseUrl, {
      ...prefix,
      sort: "hops-asc",
      minHops: String(previousHops),
      maxHops: String(previousHops),
    });
    assert.equal(before.status, 200);
    assert.ok(before.body.wallets.some((wallet) => wallet.address === target.address && wallet.hops === previousHops));

    await dbService.updateTaintedInfo(target.address, {
      d: nextHops,
      p: "seed",
      o: "seed",
      n: 1,
      t: "tx",
    });
    target.d = nextHops;

    const stale = await requestWallets(baseUrl, {
      ...prefix,
      sort: "hops-asc",
      minHops: String(previousHops),
      maxHops: String(previousHops),
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.wallets.find((wallet) => wallet.address === target.address), undefined);

    const updated = await requestWallets(baseUrl, {
      ...prefix,
      sort: "hops-asc",
      minHops: String(nextHops),
      maxHops: String(nextHops),
    });
    assert.equal(updated.status, 200);
    assert.ok(updated.body.wallets.some((wallet) => wallet.address === target.address && wallet.hops === nextHops));
  });

  test("v2 hop-boundary cursor is accepted over HTTP and continues after that degree", async () => {
    const { encodeWalletCursor } = require("../src/utils/validation");
    const query = { sort: "hops-asc", q: "1", minHops: "0", maxHops: "10", limit: "5" };
    const parsed = parseWalletListQuery(query);
    const lastAtDegreeZero = records.filter((record) => record.d === 0).sort((a, b) => a.address.localeCompare(b.address)).at(-1);
    const page = await requestWallets(baseUrl, {
      ...query,
      cursor: encodeWalletCursor(parsed, `h:${String(lastAtDegreeZero.d).padStart(16, "0")}:`, { version: 2 }),
    });
    assert.equal(page.status, 200);
    assert.ok(page.body.wallets.length > 0);
    assert.ok(page.body.wallets.every((wallet) => wallet.hops >= 1));
    assert.ok(page.body.wallets.every((wallet) => wallet.address.startsWith("1")));
  });
});
