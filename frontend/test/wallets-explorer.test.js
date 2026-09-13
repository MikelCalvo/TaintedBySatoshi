const test = require("node:test");
const assert = require("node:assert/strict");

async function loadExplorer() {
  return import("../src/utils/walletsExplorer.mjs");
}

test("builds a wallets URL with limit, global sort, and omits empty search and cursor", async () => {
  const { buildWalletsRequestUrl } = await loadExplorer();

  assert.equal(
    buildWalletsRequestUrl("http://localhost:3001", { limit: 50, sort: "address-asc" }),
    "http://localhost:3001/api/wallets?limit=50&sort=address-asc"
  );
});

test("sends case-sensitive address prefix, hop bounds, sort, and opaque cursor without rewriting case", async () => {
  const { buildWalletsRequestUrl } = await loadExplorer();

  assert.equal(
    buildWalletsRequestUrl("https://api.example", {
      limit: 50,
      q: "bc1Qxy",
      sort: "hops-desc",
      minHops: 0,
      maxHops: 10,
      cursor: "OPAQUE",
    }),
    "https://api.example/api/wallets?limit=50&q=bc1Qxy&sort=hops-desc&minHops=0&maxHops=10&cursor=OPAQUE"
  );
});

test("trims submitted prefix but keeps empty search and unset hop bounds off the query string", async () => {
  const { buildWalletsRequestUrl, normalizeSearchQuery } = await loadExplorer();

  assert.equal(normalizeSearchQuery("  1A1z  "), "1A1z");
  assert.equal(normalizeSearchQuery("   "), "");
  assert.equal(
    buildWalletsRequestUrl("http://localhost:3001", {
      limit: 25,
      q: "   ",
      cursor: "",
      sort: "address-desc",
      minHops: null,
      maxHops: null,
    }),
    "http://localhost:3001/api/wallets?limit=25&sort=address-desc"
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

test("does not expose client-only loaded-view filter or locale sort helpers", async () => {
  const explorer = await loadExplorer();

  assert.equal(explorer.filterLoadedWallets, undefined);
  assert.equal(explorer.sortLoadedWallets, undefined);
  assert.equal(explorer.applyLoadedView, undefined);
});

test("passes server-ordered wallets through without localeCompare resorting", async () => {
  const { getVisibleWallets } = await loadExplorer();
  const serverOrder = [
    { address: "bc1qaaa", hops: 1 },
    { address: "1BBB", hops: 1 },
    { address: "3Ccc", hops: 2 },
  ];

  assert.deepEqual(
    getVisibleWallets(serverOrder).map((wallet) => wallet.address),
    ["bc1qaaa", "1BBB", "3Ccc"]
  );
  assert.notDeepEqual(
    [...serverOrder].sort((left, right) =>
      String(left.address).localeCompare(String(right.address))
    ).map((wallet) => wallet.address),
    ["bc1qaaa", "1BBB", "3Ccc"]
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

test("match summary reports the global result count without a loaded-only split", async () => {
  const { getMatchSummary } = await loadExplorer();

  assert.equal(getMatchSummary({ matchCount: 50, scanned: 50 }), "Showing 50 wallets");
  assert.equal(getMatchSummary({ matchCount: 3, scanned: 150 }), "Showing 3 wallets");
  assert.doesNotMatch(
    getMatchSummary({ matchCount: 3, loadedCount: 50 }),
    /loaded wallets/i
  );
});

test("scope copy says search and hop filters apply to every indexed wallet", async () => {
  const { getScopeCopy } = await loadExplorer();
  const copy = getScopeCopy();

  assert.equal(copy, "Filters and sorting apply to all indexed wallets.");
  assert.doesNotMatch(copy, /loaded wallets only/i);
  assert.doesNotMatch(copy, /loaded-results only/i);
});

test("sort option labels stay short and do not claim loaded-only scope", async () => {
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
  assert.doesNotMatch(labels["hops-asc"], /loaded/i);
});

test("empty state keeps continue-search when a cursor remains, and only asserts no match with no cursor", async () => {
  const { getEmptyState } = await loadExplorer();

  assert.deepEqual(getEmptyState({ loading: true, error: null, loadedCount: 0, matchCount: 0 }), {
    kind: "loading",
    message: "Loading wallets...",
  });
  assert.deepEqual(
    getEmptyState({
      loading: true,
      error: null,
      loadedCount: 0,
      matchCount: 0,
      indexBuilding: {
        ready: false,
        phase: "building",
        indexed: 12,
        total: 100,
      },
    }),
    {
      kind: "index-building",
      message: "Preparing global wallet filters",
    }
  );
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
      nextCursor: "OPAQUE",
      scanned: 50,
    }),
    {
      kind: "continue-search",
      message: "No matches in this page. Continue searching the remaining indexed wallets.",
    }
  );
  assert.deepEqual(
    getEmptyState({
      loading: false,
      error: null,
      loadedCount: 0,
      matchCount: 0,
      query: "1nope",
      nextCursor: null,
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
      loadedCount: 0,
      matchCount: 0,
      minHops: 8,
      maxHops: 9,
      nextCursor: null,
    }),
    {
      kind: "no-global-matches",
      message: "No indexed wallets match this hop range.",
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

test("load more stays available when a global page is empty and a cursor exists", async () => {
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

test("auto-continues a bounded number of empty global pages then requires explicit continue", async () => {
  const { shouldAutoContinueEmptyPage, EMPTY_PAGE_AUTO_CONTINUE_MAX, getLoadMoreLabel } =
    await loadExplorer();

  assert.equal(EMPTY_PAGE_AUTO_CONTINUE_MAX, 3);
  assert.equal(
    shouldAutoContinueEmptyPage({ walletsCount: 0, nextCursor: "c1", autoContinues: 0 }),
    true
  );
  assert.equal(
    shouldAutoContinueEmptyPage({ walletsCount: 0, nextCursor: "c1", autoContinues: 2 }),
    true
  );
  assert.equal(
    shouldAutoContinueEmptyPage({ walletsCount: 0, nextCursor: "c1", autoContinues: 3 }),
    false
  );
  assert.equal(
    shouldAutoContinueEmptyPage({ walletsCount: 1, nextCursor: "c1", autoContinues: 0 }),
    false
  );
  assert.equal(getLoadMoreLabel({ walletsCount: 10, loading: false }), "Load more");
  assert.equal(
    getLoadMoreLabel({ walletsCount: 0, autoContinuesExhausted: true, loading: false }),
    "Continue searching"
  );
  assert.equal(getLoadMoreLabel({ loading: true }), "Loading...");
});

test("parses WALLET_INDEX_BUILDING 503 payloads and never treats them as a local fallback", async () => {
  const { parseWalletsIndexBuilding, getIndexBuildingCopy } = await loadExplorer();

  const parsed = parseWalletsIndexBuilding({
    status: 503,
    body: {
      error: "WALLET_INDEX_BUILDING",
      message: "Wallet hop index is still building",
      index: { ready: false, phase: "building", indexed: 12, total: 100, error: null },
      retryAfter: 5,
    },
  });

  assert.deepEqual(parsed, {
    building: true,
    retryAfter: 5,
    index: { ready: false, phase: "building", indexed: 12, total: 100, error: null },
    message: "Wallet hop index is still building",
  });
  assert.equal(getIndexBuildingCopy(parsed.index), "Preparing global wallet filters");
  assert.equal(parseWalletsIndexBuilding({ status: 500, body: { error: "boom" } }), null);
});

test("auto-refresh is 60s, skipped while loading, hidden, unmounted, or while the index is building", async () => {
  const { shouldRefreshWalletsSnapshot, WALLETS_AUTO_REFRESH_MS, formatWalletsUpdatedAt } =
    await loadExplorer();

  assert.equal(WALLETS_AUTO_REFRESH_MS, 60000);
  assert.equal(
    shouldRefreshWalletsSnapshot({
      loading: false,
      visible: true,
      mounted: true,
      indexBuilding: false,
    }),
    true
  );
  assert.equal(
    shouldRefreshWalletsSnapshot({
      loading: true,
      visible: true,
      mounted: true,
      indexBuilding: false,
    }),
    false
  );
  assert.equal(
    shouldRefreshWalletsSnapshot({
      loading: false,
      visible: false,
      mounted: true,
      indexBuilding: false,
    }),
    false
  );
  assert.equal(
    shouldRefreshWalletsSnapshot({
      loading: false,
      visible: true,
      mounted: false,
      indexBuilding: false,
    }),
    false
  );
  assert.equal(
    shouldRefreshWalletsSnapshot({
      loading: false,
      visible: true,
      mounted: true,
      indexBuilding: true,
    }),
    false
  );
  assert.match(formatWalletsUpdatedAt(new Date("2026-09-13T12:00:00.000Z")), /Updated /);
});

test("card layout is used below the desktop breakpoint and table layout on desktop", async () => {
  const { usesCardLayout, DESKTOP_TABLE_MIN_WIDTH } = await loadExplorer();

  assert.equal(DESKTOP_TABLE_MIN_WIDTH, 900);
  assert.equal(usesCardLayout(375), true);
  assert.equal(usesCardLayout(899), true);
  assert.equal(usesCardLayout(900), false);
});
