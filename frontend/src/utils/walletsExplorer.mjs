export const WALLET_PAGE_SIZE = 50;
export const DESKTOP_TABLE_MIN_WIDTH = 900;
export const WALLETS_FETCH_TIMEOUT_MS = 15000;

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
  { limit = WALLET_PAGE_SIZE, q, cursor } = {}
) {
  const base = String(apiUrl || "").replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  const query = normalizeSearchQuery(q);
  if (query) params.set("q", query);
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

export function filterLoadedWallets(
  wallets,
  { minHops = null, maxHops = null } = {}
) {
  return (wallets || []).filter((wallet) => {
    const hops = Number(wallet?.hops);
    if (minHops != null && hops < minHops) return false;
    if (maxHops != null && hops > maxHops) return false;
    return true;
  });
}

export function sortLoadedWallets(wallets, sort = "address-asc") {
  const copy = [...(wallets || [])];
  copy.sort((left, right) => {
    if (sort === "hops-asc" || sort === "hops-desc") {
      const direction = sort === "hops-asc" ? 1 : -1;
      if (left.hops !== right.hops) return (left.hops - right.hops) * direction;
      return String(left.address).localeCompare(String(right.address));
    }
    const ordered = String(left.address).localeCompare(String(right.address));
    return sort === "address-desc" ? -ordered : ordered;
  });
  return copy;
}

export function applyLoadedView(wallets, { sort, minHops = null, maxHops = null } = {}) {
  return sortLoadedWallets(filterLoadedWallets(wallets, { minHops, maxHops }), sort);
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

export function getMatchSummary({ matchCount, loadedCount }) {
  const matches = Number(matchCount) || 0;
  const loaded = Number(loadedCount) || 0;
  if (matches === loaded) {
    return `Showing ${loaded.toLocaleString()} loaded wallets`;
  }
  return `Showing ${matches.toLocaleString()} of ${loaded.toLocaleString()} loaded wallets`;
}

export function getScopeCopy() {
  return "Search all indexed addresses by prefix (case-sensitive). Hop filters and sorting apply to loaded wallets only.";
}

export function getEmptyState({
  loading,
  error,
  loadedCount,
  matchCount,
  query,
  minHops,
  maxHops,
}) {
  if (loading && !loadedCount) {
    return { kind: "loading", message: "Loading wallets..." };
  }
  if (matchCount > 0) return null;
  if (error) {
    return { kind: "error", message: error };
  }
  if (!loadedCount && normalizeSearchQuery(query)) {
    return {
      kind: "no-prefix-matches",
      message: "No indexed wallets match this address prefix.",
    };
  }
  if (loadedCount > 0 && (minHops != null || maxHops != null)) {
    return {
      kind: "no-loaded-matches",
      message:
        "No loaded wallets match this hop range. Load more to include additional wallets, or reset the hop filter.",
    };
  }
  if (loadedCount > 0) {
    return {
      kind: "no-loaded-matches",
      message:
        "No loaded wallets match this hop range. Load more to include additional wallets, or reset the hop filter.",
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

export function usesCardLayout(width) {
  return Number(width) < DESKTOP_TABLE_MIN_WIDTH;
}
