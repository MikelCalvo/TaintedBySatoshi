const test = require("node:test");
const assert = require("node:assert/strict");

async function loadExplorer() {
  return import("../src/utils/walletsExplorer.mjs");
}

const sample = [
  { address: "bc1qaaa", hops: 4, parent: "p1", origin: "o1" },
  { address: "1BBB", hops: 1, parent: "p2", origin: "o2" },
  { address: "3Ccc", hops: 1, parent: "p3", origin: "o3" },
  { address: "1AAA", hops: 12, parent: null, origin: null },
];

test("builds a wallets URL with limit and omits empty search and cursor", async () => {
  const { buildWalletsRequestUrl } = await loadExplorer();

  assert.equal(
    buildWalletsRequestUrl("http://localhost:3001", { limit: 50 }),
    "http://localhost:3001/api/wallets?limit=50"
  );
});

test("sends case-sensitive address prefix and cursor without rewriting case", async () => {
  const { buildWalletsRequestUrl } = await loadExplorer();

  assert.equal(
    buildWalletsRequestUrl("https://api.example", {
      limit: 50,
      q: "bc1Qxy",
      cursor: "1Last",
    }),
    "https://api.example/api/wallets?limit=50&q=bc1Qxy&cursor=1Last"
  );
});

test("trims submitted prefix but keeps empty search off the query string", async () => {
  const { buildWalletsRequestUrl, normalizeSearchQuery } = await loadExplorer();

  assert.equal(normalizeSearchQuery("  1A1z  "), "1A1z");
  assert.equal(normalizeSearchQuery("   "), "");
  assert.equal(
    buildWalletsRequestUrl("http://localhost:3001", {
      limit: 25,
      q: "   ",
      cursor: "",
    }),
    "http://localhost:3001/api/wallets?limit=25"
  );
});

test("parses optional nonnegative hop bounds and rejects invalid input", async () => {
  const { parseHopBound } = await loadExplorer();

  assert.equal(parseHopBound(""), null);
  assert.equal(parseHopBound("  "), null);
  assert.equal(parseHopBound("0"), 0);
  assert.equal(parseHopBound("12"), 12);
  assert.equal(parseHopBound("12.0"), 12);
  assert.equal(parseHopBound("-1"), undefined);
  assert.equal(parseHopBound("1.5"), undefined);
  assert.equal(parseHopBound("abc"), undefined);
});

test("hop range is valid when unset or when min is not greater than max", async () => {
  const { isHopRangeValid } = await loadExplorer();

  assert.equal(isHopRangeValid(null, null), true);
  assert.equal(isHopRangeValid(0, null), true);
  assert.equal(isHopRangeValid(null, 3), true);
  assert.equal(isHopRangeValid(2, 2), true);
  assert.equal(isHopRangeValid(3, 2), false);
  assert.equal(isHopRangeValid(undefined, 1), false);
});

test("filters loaded wallets by hop range without touching address prefix matching", async () => {
  const { filterLoadedWallets } = await loadExplorer();

  assert.deepEqual(
    filterLoadedWallets(sample, { minHops: 1, maxHops: 1 }).map((w) => w.address),
    ["1BBB", "3Ccc"]
  );
  assert.deepEqual(
    filterLoadedWallets(sample, { minHops: 4, maxHops: null }).map((w) => w.address),
    ["bc1qaaa", "1AAA"]
  );
});

test("sorts loaded wallets by hops or address and keeps hop ties stable by address", async () => {
  const { sortLoadedWallets } = await loadExplorer();

  assert.deepEqual(
    sortLoadedWallets(sample, "hops-asc").map((w) => w.address),
    ["1BBB", "3Ccc", "bc1qaaa", "1AAA"]
  );
  assert.deepEqual(
    sortLoadedWallets(sample, "hops-desc").map((w) => w.address),
    ["1AAA", "bc1qaaa", "1BBB", "3Ccc"]
  );
  assert.deepEqual(
    sortLoadedWallets(sample, "address-asc").map((w) => w.address),
    ["1AAA", "1BBB", "3Ccc", "bc1qaaa"]
  );
  assert.deepEqual(
    sortLoadedWallets(sample, "address-desc").map((w) => w.address),
    ["bc1qaaa", "3Ccc", "1BBB", "1AAA"]
  );
});

test("applies hop filter then sort on a copy of loaded results", async () => {
  const { applyLoadedView } = await loadExplorer();
  const original = sample.map((wallet) => ({ ...wallet }));

  const viewed = applyLoadedView(original, {
    sort: "hops-desc",
    minHops: 1,
    maxHops: 4,
  });

  assert.deepEqual(
    viewed.map((w) => w.address),
    ["bc1qaaa", "1BBB", "3Ccc"]
  );
  assert.deepEqual(
    original.map((w) => w.address),
    sample.map((w) => w.address)
  );
});

test("dedupes appended pages by address and keeps the first record", async () => {
  const { mergeWalletPages } = await loadExplorer();

  const merged = mergeWalletPages(
    [{ address: "1AAA", hops: 1 }],
    [
      { address: "1AAA", hops: 9 },
      { address: "1BBB", hops: 2 },
    ]
  );

  assert.deepEqual(merged, [
    { address: "1AAA", hops: 1 },
    { address: "1BBB", hops: 2 },
  ]);
});

test("match summary reports filtered count against total loaded", async () => {
  const { getMatchSummary } = await loadExplorer();

  assert.equal(
    getMatchSummary({ matchCount: 3, loadedCount: 50 }),
    "Showing 3 of 50 loaded wallets"
  );
  assert.equal(
    getMatchSummary({ matchCount: 50, loadedCount: 50 }),
    "Showing 50 loaded wallets"
  );
  assert.equal(
    getMatchSummary({ matchCount: 0, loadedCount: 50 }),
    "Showing 0 of 50 loaded wallets"
  );
});

test("scope copy labels hop sort and hop range as loaded-results only", async () => {
  const { getScopeCopy } = await loadExplorer();
  const copy = getScopeCopy({
    query: "1A",
    sort: "hops-asc",
    minHops: 0,
    maxHops: 3,
  });

  assert.equal(
    copy,
    "Search all indexed addresses by prefix (case-sensitive). Hop filters and sorting apply to loaded wallets only."
  );
  assert.match(copy, /indexed addresses by prefix/i);
  assert.match(copy, /loaded wallets only/i);
  assert.doesNotMatch(copy, /all wallets by hops/i);
});

test("sort option labels stay short while hop sorts still say they apply to loaded results", async () => {
  const { SORT_OPTIONS } = await loadExplorer();
  const labels = Object.fromEntries(
    SORT_OPTIONS.map((option) => [option.value, option.label])
  );

  assert.equal(labels["address-asc"], "Address A–Z");
  assert.equal(labels["address-desc"], "Address Z–A");
  assert.equal(labels["hops-asc"], "Hops low–high");
  assert.equal(labels["hops-desc"], "Hops high–low");
  assert.ok(labels["hops-asc"].length < 24);
  assert.ok(labels["hops-desc"].length < 24);
});

test("empty state distinguishes loading, error, prefix miss, and local hop miss", async () => {
  const { getEmptyState } = await loadExplorer();

  assert.deepEqual(getEmptyState({ loading: true, error: null, loadedCount: 0, matchCount: 0 }), {
    kind: "loading",
    message: "Loading wallets...",
  });
  assert.deepEqual(
    getEmptyState({
      loading: false,
      error: "Failed to load tainted wallets",
      loadedCount: 10,
      matchCount: 0,
    }),
    {
      kind: "error",
      message: "Failed to load tainted wallets",
    }
  );
  assert.deepEqual(
    getEmptyState({
      loading: false,
      error: null,
      loadedCount: 0,
      matchCount: 0,
      query: "1nope",
    }),
    {
      kind: "no-prefix-matches",
      message: "No indexed wallets match this address prefix.",
    }
  );
  assert.deepEqual(
    getEmptyState({
      loading: false,
      error: null,
      loadedCount: 50,
      matchCount: 0,
      minHops: 8,
      maxHops: 9,
    }),
    {
      kind: "no-loaded-matches",
      message:
        "No loaded wallets match this hop range. Load more to include additional wallets, or reset the hop filter.",
    }
  );
  assert.equal(
    getEmptyState({
      loading: false,
      error: null,
      loadedCount: 4,
      matchCount: 4,
    }),
    null
  );
});

test("load more stays available when local filters yield zero and a cursor exists", async () => {
  const { shouldShowLoadMore } = await loadExplorer();

  assert.equal(
    shouldShowLoadMore({ nextCursor: "1Next", matchCount: 0, loading: false }),
    true
  );
  assert.equal(
    shouldShowLoadMore({ nextCursor: null, matchCount: 0, loading: false }),
    false
  );
});

test("card layout is used below the desktop breakpoint and table layout on desktop", async () => {
  const { usesCardLayout, DESKTOP_TABLE_MIN_WIDTH } = await loadExplorer();

  assert.equal(DESKTOP_TABLE_MIN_WIDTH, 900);
  assert.equal(usesCardLayout(375), true);
  assert.equal(usesCardLayout(899), true);
  assert.equal(usesCardLayout(900), false);
});
