const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Level } = require("level");
const { walletHopIndexKey: h } = require("../src/services/walletIndexKeys");
const { queryWallets } = require("../src/services/walletQueryService");
const { parseWalletListQuery, encodeWalletCursor } = require("../src/utils/validation");

const RECORD = { p: "seed", o: "seed", n: 1, t: "tx" };
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function expectedOrder(records, { sort, q = null, minHops = null, maxHops = null }) {
  const reverse = sort.endsWith("desc") ? -1 : 1;
  return records
    .filter((record) => (q == null || record.address.startsWith(q))
      && (minHops == null || record.d >= minHops)
      && (maxHops == null || record.d <= maxHops))
    .sort((a, b) => reverse * (sort.startsWith("hops")
      ? (a.d - b.d || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      : (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)));
}

function opsFor(records) {
  return records.flatMap((record) => [
    { type: "put", key: `a:${record.address}`, value: { d: record.d, ...RECORD } },
    { type: "put", key: h(record.address, record.d), value: 1 },
  ]);
}

async function withDb(records, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tbs-bounded-"));
  const db = new Level(dir, { valueEncoding: "json" });
  try {
    await db.batch(opsFor(records));
    return await work(db, records);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueDegrees(count, { addressPrefix = "1", degreeOffset = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    address: `${addressPrefix}${String(i).padStart(8, "0")}w`,
    d: degreeOffset + i,
  }));
}

async function collectPages(db, query, { maxPages = 400 } = {}) {
  const found = [];
  const pages = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await queryWallets(db, parseWalletListQuery({ ...query, cursor }));
    pages.push(page);
    found.push(...page.wallets);
    cursor = page.nextCursor;
    if (!cursor) return { found, pages };
  }
  throw new Error("pagination exceeded maxPages");
}

function assertGroundTruth(found, records, query) {
  const expected = expectedOrder(records, query);
  assert.deepEqual(found.map((wallet) => wallet.address), expected.map((record) => record.address));
  assert.equal(new Set(found.map((wallet) => wallet.address)).size, found.length);
}

function instrument(db) {
  let snapshots = 0;
  let snapClosed = 0;
  let iterators = 0;
  let iterClosed = 0;
  const getManySizes = [];
  const getManyOptions = [];
  const iteratorOptions = [];
  const originalSnapshot = db.snapshot.bind(db);
  const originalIterator = db.iterator.bind(db);
  const originalGetMany = db.getMany.bind(db);
  db.snapshot = () => {
    snapshots += 1;
    const snapshot = originalSnapshot();
    const close = snapshot.close.bind(snapshot);
    let closed = false;
    snapshot.close = async () => {
      if (!closed) {
        closed = true;
        snapClosed += 1;
      }
      return close();
    };
    return snapshot;
  };
  db.iterator = (options) => {
    iterators += 1;
    iteratorOptions.push(options);
    const iterator = originalIterator(options);
    const close = iterator.close.bind(iterator);
    let closed = false;
    iterator.close = async () => {
      if (!closed) {
        closed = true;
        iterClosed += 1;
      }
      return close();
    };
    return iterator;
  };
  db.getMany = async (keys, options) => {
    getManySizes.push(keys.length);
    getManyOptions.push(options || {});
    return originalGetMany(keys, options);
  };
  return {
    getManySizes,
    getManyOptions,
    iteratorOptions,
    assertClosed() {
      assert.equal(snapClosed, snapshots);
      assert.equal(iterClosed, iterators);
      assert.ok(snapshots >= 1);
    },
  };
}

test("hop sort over more than 512 occupied degrees returns the lowest hops without 422", async () => {
  const records = uniqueDegrees(520);
  await withDb(records, async (db) => {
    const page = await queryWallets(db, parseWalletListQuery({ sort: "hops-asc", limit: 20 }));
    assert.equal(page.wallets.length, 20);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    assert.notEqual(page.scanLimited, true);
    assert.deepEqual(
      page.wallets.map((wallet) => wallet.hops),
      expectedOrder(records, { sort: "hops-asc" }).slice(0, 20).map((record) => record.d)
    );
    assert.ok(page.scanned <= 21, page.scanned);
  });
});

test("hop desc over more than 512 occupied degrees returns the highest hops first", async () => {
  const records = uniqueDegrees(520);
  await withDb(records, async (db) => {
    const page = await queryWallets(db, parseWalletListQuery({ sort: "hops-desc", limit: 20 }));
    assert.equal(page.wallets.length, 20);
    assert.deepEqual(
      page.wallets.map((wallet) => wallet.address),
      expectedOrder(records, { sort: "hops-desc" }).slice(0, 20).map((record) => record.address)
    );
    assert.ok(page.scanned <= 21, page.scanned);
  });
});

test("hop sort pages every wallet across >512 degrees without duplicates", async () => {
  const records = uniqueDegrees(520);
  await withDb(records, async (db) => {
    for (const sort of ["hops-asc", "hops-desc"]) {
      const { found, pages } = await collectPages(db, { sort, limit: 40 });
      assertGroundTruth(found, records, { sort });
      assert.ok(pages.every((page) => page.scanned <= 41), pages.map((page) => page.scanned));
      assert.ok(pages.every((page) => page.scanLimited !== true));
    }
  });
});

test("limit 50 hop sort uses 50+1 iterator reads independent of total occupied degrees", async () => {
  const records = uniqueDegrees(530);
  await withDb(records, async (db) => {
    const tracked = instrument(db);
    const page = await queryWallets(db, parseWalletListQuery({ sort: "hops-asc", limit: 50 }));
    assert.equal(page.wallets.length, 50);
    assert.equal(page.hasMore, true);
    assert.equal(page.scanned, 51);
    assert.ok(tracked.getManySizes.every((size) => size <= 50), tracked.getManySizes);
    assert.ok(tracked.getManyOptions.every((options) => options.fillCache === false));
    assert.ok(tracked.iteratorOptions.length <= 2, tracked.iteratorOptions.length);
    assert.ok(tracked.iteratorOptions.every((options) => options.fillCache === false));
    tracked.assertClosed();
  });
});

test("address sort with a hop filter spanning >512 degrees stays bounded and complete", async () => {
  const records = uniqueDegrees(520);
  await withDb(records, async (db) => {
    for (const sort of ["address-asc", "address-desc"]) {
      const query = { sort, minHops: 0, maxHops: 519, limit: 45 };
      const { found, pages } = await collectPages(db, query);
      assertGroundTruth(found, records, query);
      assert.ok(pages[0].wallets.length > 0);
      assert.ok(pages.every((page) => page.scanned <= 2000));
    }
  });
});

test("small hop-range address sort still globally orders mixed prefixes", async () => {
  const records = uniqueDegrees(80).concat(
    uniqueDegrees(40, { addressPrefix: "3", degreeOffset: 2 })
  );
  await withDb(records, async (db) => {
    const query = { sort: "address-desc", minHops: 2, maxHops: 7, limit: 11 };
    const { found } = await collectPages(db, query);
    assertGroundTruth(found, records, query);
    assert.ok(found.length > 0);
  });
});

test("hop-order ties reverse with desc and exclusive cursors do not skip or duplicate", async () => {
  const records = [
    { address: "1aaaTie", d: 3 },
    { address: "1mmmTie", d: 3 },
    { address: "1zzzTie", d: 3 },
    { address: "1low", d: 1 },
    { address: "1high", d: 9 },
  ];
  await withDb(records, async (db) => {
    for (const sort of ["hops-asc", "hops-desc"]) {
      const query = { sort, minHops: 1, maxHops: 9, limit: 2 };
      const { found } = await collectPages(db, query);
      assertGroundTruth(found, records, query);
    }
    const first = await queryWallets(db, parseWalletListQuery({ sort: "hops-desc", limit: 2 }));
    assert.deepEqual(first.wallets.map((wallet) => wallet.address), ["1high", "1zzzTie"]);
    const second = await queryWallets(db, parseWalletListQuery({
      sort: "hops-desc",
      limit: 2,
      cursor: first.nextCursor,
    }));
    assert.deepEqual(second.wallets.map((wallet) => wallet.address), ["1mmmTie", "1aaaTie"]);
  });
});

test("prefix plus hop order pages mixed queries to in-memory ground truth", async () => {
  const records = uniqueDegrees(90).concat(
    uniqueDegrees(30, { addressPrefix: "bc", degreeOffset: 4 }),
    uniqueDegrees(25, { addressPrefix: "3", degreeOffset: 1 })
  );
  await withDb(records, async (db) => {
    const queries = [
      { sort: "hops-asc", q: "1", minHops: 2, maxHops: 20, limit: 13 },
      { sort: "hops-desc", q: "bc", minHops: 4, maxHops: 40, limit: 7 },
      { sort: "address-asc", q: "3", minHops: 1, maxHops: 10, limit: 9 },
      { sort: "hops-asc", q: "10000012", limit: 5 },
    ];
    for (const query of queries) {
      const { found } = await collectPages(db, query);
      assertGroundTruth(found, records, query);
    }
  });
});

test("huge safe-integer hop gaps sort in both directions without overflowing bounds", async () => {
  const records = [
    { address: "1gapLow", d: 0 },
    { address: "1gapMid", d: 1 },
    { address: "1gapHigh", d: MAX_SAFE },
  ];
  await withDb(records, async (db) => {
    const asc = await queryWallets(db, parseWalletListQuery({ sort: "hops-asc", limit: 10 }));
    assert.deepEqual(asc.wallets.map((wallet) => wallet.hops), [0, 1, MAX_SAFE]);
    assert.equal(asc.hasMore, false);
    const desc = await queryWallets(db, parseWalletListQuery({ sort: "hops-desc", limit: 10 }));
    assert.deepEqual(desc.wallets.map((wallet) => wallet.hops), [MAX_SAFE, 1, 0]);
    const ranged = await queryWallets(db, parseWalletListQuery({
      sort: "hops-asc",
      minHops: String(MAX_SAFE),
      maxHops: String(MAX_SAFE),
      limit: 5,
    }));
    assert.deepEqual(ranged.wallets.map((wallet) => wallet.address), ["1gapHigh"]);
  });
});

test("sparse prefix hop walks return resumable scan progress instead of false completion", async () => {
  const distractors = uniqueDegrees(2200, { addressPrefix: "z" });
  const matches = uniqueDegrees(120, { addressPrefix: "1p", degreeOffset: 3000 });
  const records = distractors.concat(matches);
  await withDb(records, async (db) => {
    const query = { sort: "hops-asc", q: "1p", limit: 20 };
    const { found, pages } = await collectPages(db, query, { maxPages: 20 });
    assertGroundTruth(found, records, query);
    assert.equal(found.length, 120);
    for (const page of pages) {
      if (page.scanLimited === true) {
        assert.equal(page.hasMore, true);
        assert.ok(page.nextCursor);
      }
    }
    assert.notEqual(pages.at(-1).hasMore, true);
    assert.equal(pages.at(-1).nextCursor, null);
  });
});

test("wide address-order hop filter over a sparse range underfills with a resumable cursor", async () => {
  const early = uniqueDegrees(2100, { addressPrefix: "1" }).map((record) => ({ ...record, d: 1 }));
  const late = uniqueDegrees(600, { addressPrefix: "z", degreeOffset: 2 });
  const records = early.concat(late);
  await withDb(records, async (db) => {
    const query = { sort: "address-asc", minHops: 2, maxHops: 601, limit: 10 };
    const first = await queryWallets(db, parseWalletListQuery(query));
    assert.equal(first.scanLimited, true);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    assert.ok(first.wallets.length < 10);
    const { found } = await collectPages(db, query, { maxPages: 80 });
    assertGroundTruth(found, records, query);
  });
});

test("authoritative hop mismatch throws and still closes snapshot plus iterators", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tbs-mismatch-"));
  const db = new Level(dir, { valueEncoding: "json" });
  try {
    await db.put("a:1mismatch", { d: 1, ...RECORD });
    await db.put(h("1mismatch", 2), 1);
    const tracked = instrument(db);
    await assert.rejects(
      () => queryWallets(db, parseWalletListQuery({ sort: "hops-asc", limit: 5 })),
      /hop index does not match/i
    );
    tracked.assertClosed();
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v1 hop cursors remain valid while v2 bucket boundaries resume after that degree", async () => {
  const records = [
    { address: "bc1aaa", d: 2 },
    { address: "bc1bbb", d: 2 },
    { address: "bc1ccc", d: 5 },
    { address: "zskip", d: 3 },
  ];
  await withDb(records, async (db) => {
    const first = await queryWallets(db, parseWalletListQuery({ sort: "hops-asc", q: "bc1", limit: 1 }));
    assert.equal(first.wallets[0].address, "bc1aaa");
    const parsed = parseWalletListQuery({ sort: "hops-asc", q: "bc1", limit: 1, cursor: first.nextCursor });
    assert.match(parsed.cursor, /^h:\d{16}:bc1aaa$/);
    const continued = await queryWallets(db, parsed);
    assert.equal(continued.wallets[0].address, "bc1bbb");

    const boundary = encodeWalletCursor(
      parseWalletListQuery({ sort: "hops-asc", q: "bc1", limit: 10 }),
      "h:0000000000000002:",
      { version: 2 }
    );
    const afterDegree = await queryWallets(db, parseWalletListQuery({
      sort: "hops-asc",
      q: "bc1",
      limit: 10,
      cursor: boundary,
    }));
    assert.deepEqual(afterDegree.wallets.map((wallet) => wallet.address), ["bc1ccc"]);
  });
});

test("lazy hop prefix seek does not skip a later matching address in the same occupied degree", async () => {
  const records = [
    { address: "0earlyAtHop", d: 4 },
    { address: "zzlaterMatch", d: 4 },
    { address: "zznextHop", d: 5 },
  ];
  await withDb(records, async (db) => {
    const query = { sort: "hops-asc", q: "zz", limit: 10 };
    const { found } = await collectPages(db, query);
    assertGroundTruth(found, records, query);
    assert.deepEqual(found.map((wallet) => wallet.address), ["zzlaterMatch", "zznextHop"]);
  });
});

