export const WALLET_PAGE_SIZE = 50;
export const DESKTOP_TABLE_MIN_WIDTH = 900;
export const WALLETS_FETCH_TIMEOUT_MS = 15000;
export const EMPTY_PAGE_AUTO_CONTINUE_MAX = 3;
export const WALLETS_AUTO_REFRESH_MS = 60000;
export const WALLET_INDEX_RETRY_MS = 5000;

export const SORT_OPTIONS = [
  { value: "address-asc", label: "Address A–Z" },
  { value: "address-desc", label: "Address Z–A" },
  { value: "hops-asc", label: "Hops low–high" },
  { value: "hops-desc", label: "Hops high–low" },
];

export function normalizeSearchQuery(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function buildWalletsRequestUrl(
  apiUrl,
  { limit = WALLET_PAGE_SIZE, q, cursor, sort, minHops, maxHops } = {}
) {
  const base = String(apiUrl || "").replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  const query = normalizeSearchQuery(q);
  if (query) params.set("q", query);
  if (sort) params.set("sort", String(sort));
  if (minHops != null) params.set("minHops", String(minHops));
  if (maxHops != null) params.set("maxHops", String(maxHops));
  if (cursor) params.set("cursor", String(cursor));
  return `${base}/api/wallets?${params.toString()}`;
}

export function parseHopBound(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  if (!/^\d+(?:\.0+)?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function isHopRangeValid(minHops, maxHops) {
  if (minHops === undefined || maxHops === undefined) return false;
  if (minHops == null || maxHops == null) return true;
  return minHops <= maxHops;
}

export function getVisibleWallets(wallets) {
  return wallets || [];
}

export function mergeWalletPages(current, incoming) {
  const merged = [...(current || [])];
  const seen = new Set(merged.map((wallet) => wallet.address));
  for (const wallet of incoming || []) {
    if (!wallet?.address || seen.has(wallet.address)) continue;
    seen.add(wallet.address);
    merged.push(wallet);
  }
  return merged;
}

export function getMatchSummary({ matchCount }) {
  const matches = Number(matchCount) || 0;
  return `Showing ${matches.toLocaleString()} wallets`;
}

export function getScopeCopy() {
  return "Filters and sorting apply to all indexed wallets.";
}

export function getIndexBuildingCopy() {
  return "Preparing global wallet filters";
}

export function getEmptyState({
  loading,
  error,
  loadedCount,
  matchCount,
  query,
  minHops,
  maxHops,
  nextCursor,
  indexBuilding,
}) {
  if (indexBuilding && !indexBuilding.ready) {
    return { kind: "index-building", message: getIndexBuildingCopy(indexBuilding) };
  }
  if (loading && !loadedCount) {
    return { kind: "loading", message: "Loading wallets..." };
  }
  if (matchCount > 0) return null;
  if (error) {
    return { kind: "error", message: error };
  }
  if (nextCursor) {
    return {
      kind: "continue-search",
      message: "No matches in this page. Continue searching the remaining indexed wallets.",
    };
  }
  if (normalizeSearchQuery(query)) {
    return {
      kind: "no-prefix-matches",
      message: "No indexed wallets match this address prefix.",
    };
  }
  if (minHops != null || maxHops != null) {
    return {
      kind: "no-global-matches",
      message: "No indexed wallets match this hop range.",
    };
  }
  return {
    kind: "empty",
    message: "No tainted wallets to display yet.",
  };
}

export function shouldShowLoadMore({ nextCursor }) {
  return Boolean(nextCursor);
}

export function shouldAutoContinueEmptyPage({
  walletsCount = 0,
  nextCursor,
  autoContinues = 0,
} = {}) {
  return walletsCount === 0 && Boolean(nextCursor) && autoContinues < EMPTY_PAGE_AUTO_CONTINUE_MAX;
}

export function getLoadMoreLabel({
  walletsCount = 0,
  autoContinuesExhausted = false,
  loading = false,
} = {}) {
  if (loading) return "Loading...";
  if (walletsCount === 0 && autoContinuesExhausted) return "Continue searching";
  return "Load more";
}

export function parseWalletsIndexBuilding({ status, body } = {}) {
  if (Number(status) !== 503) return null;
  if (body?.error !== "WALLET_INDEX_BUILDING") return null;
  const index = body.index || { ready: false };
  return {
    building: true,
    retryAfter: Number(body.retryAfter) > 0 ? Number(body.retryAfter) : 5,
    index,
    message: body.message || getIndexBuildingCopy(index),
  };
}

export function shouldRefreshWalletsSnapshot({
  loading,
  visible,
  mounted,
  indexBuilding,
} = {}) {
  return Boolean(mounted && visible && !loading && !indexBuilding);
}

export function formatWalletsUpdatedAt(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Updated ${date.toLocaleString()}`;
}

export function usesCardLayout(width) {
  return Number(width) < DESKTOP_TABLE_MIN_WIDTH;
}
