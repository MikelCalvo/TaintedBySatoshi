import {
  WALLET_INDEX_RETRY_MS,
  WALLET_PAGE_SIZE,
  WALLETS_AUTO_REFRESH_MS,
  WALLETS_FETCH_TIMEOUT_MS,
  buildWalletsRequestUrl,
  mergeWalletPages,
  normalizeSearchQuery,
  parseWalletsIndexBuilding,
  shouldRefreshWalletsSnapshot,
} from "./walletsExplorer.mjs";

export { WALLETS_AUTO_REFRESH_MS };

function clearLoadedResults(state, extras = {}) {
  return {
    ...state,
    wallets: [],
    nextCursor: null,
    pendingCursor: null,
    error: null,
    loading: true,
    autoContinues: 0,
    scanned: null,
    hasMore: null,
    indexBuilding: null,
    retryAfter: null,
    updatedAt: null,
    ...extras,
  };
}

export function createInitialWalletsSession() {
  return {
    wallets: [],
    nextCursor: null,
    pendingCursor: null,
    appliedQuery: "",
    draftQuery: "",
    sort: "address-asc",
    draftMinHops: "",
    draftMaxHops: "",
    minHops: null,
    maxHops: null,
    error: null,
    loading: true,
    requestId: 0,
    autoContinues: 0,
    scanned: null,
    hasMore: null,
    indexBuilding: null,
    retryAfter: null,
    updatedAt: null,
  };
}

export function reduceWalletsSession(state, action) {
  switch (action.type) {
    case "set-draft-query":
      return { ...state, draftQuery: action.query };
    case "set-draft-hops":
      return {
        ...state,
        draftMinHops: action.minHops,
        draftMaxHops: action.maxHops,
      };
    case "set-sort":
      return clearLoadedResults(state, { sort: action.sort });
    case "apply-hop-range":
      return clearLoadedResults(state, {
        minHops: action.minHops ?? null,
        maxHops: action.maxHops ?? null,
      });
    case "submit-search": {
      const query = normalizeSearchQuery(action.query);
      return clearLoadedResults(state, {
        appliedQuery: query,
        draftQuery: query,
      });
    }
    case "refresh-snapshot":
      return clearLoadedResults(state);
    case "reset":
      return {
        ...createInitialWalletsSession(),
        loading: true,
      };
    case "load-more":
      if (!state.nextCursor) return state;
      return {
        ...state,
        loading: true,
        error: null,
        pendingCursor: state.nextCursor,
      };
    case "auto-continue":
      if (!state.nextCursor) return state;
      return {
        ...state,
        loading: true,
        error: null,
        pendingCursor: state.nextCursor,
        autoContinues: (state.autoContinues || 0) + 1,
      };
    case "fetch-started":
      return {
        ...state,
        loading: true,
        requestId: action.requestId,
      };
    case "fetch-succeeded":
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        loading: false,
        error: null,
        wallets: action.append
          ? mergeWalletPages(state.wallets, action.wallets || [])
          : action.wallets || [],
        nextCursor: action.nextCursor || null,
        pendingCursor: null,
        scanned: action.scanned ?? state.scanned,
        hasMore: action.hasMore ?? Boolean(action.nextCursor),
        indexBuilding: null,
        retryAfter: null,
        updatedAt: action.updatedAt || state.updatedAt,
      };
    case "index-building":
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        loading: true,
        error: null,
        indexBuilding: action.index || { ready: false },
        retryAfter: action.retryAfter || 5,
      };
    case "fetch-failed":
      if (action.aborted || action.requestId !== state.requestId) return state;
      return {
        ...state,
        loading: false,
        error: action.error || "Failed to load tainted wallets",
        pendingCursor: null,
        indexBuilding: null,
      };
    default:
      return state;
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (response.ok) throw error;
    return null;
  }
}

export function createWalletsLoader({
  fetchImpl = fetch,
  apiUrl,
  timeoutMs = WALLETS_FETCH_TIMEOUT_MS,
  limit = WALLET_PAGE_SIZE,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let controller = null;
  let currentRequestId = 0;

  async function load({
    q,
    cursor,
    sort,
    minHops,
    maxHops,
    append = false,
    apply = () => {},
  } = {}) {
    if (controller) controller.abort();
    controller = new AbortController();
    const requestId = ++currentRequestId;
    apply({ type: "fetch-started", requestId });
    const manualSignal = controller.signal;
    let timeoutSignal;
    const url = buildWalletsRequestUrl(apiUrl, {
      limit,
      q,
      cursor,
      sort,
      minHops,
      maxHops,
    });

    try {
      while (requestId === currentRequestId) {
        timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([manualSignal, timeoutSignal]);
        const response = await fetchImpl(url, { signal });
        if (requestId !== currentRequestId) return;
        const data = await readJson(response);
        if (requestId !== currentRequestId) return;
        const indexBuilding = parseWalletsIndexBuilding({
          status: response.status,
          body: data,
        });
        if (indexBuilding) {
          apply({
            type: "index-building",
            requestId,
            retryAfter: indexBuilding.retryAfter,
            index: indexBuilding.index,
            message: indexBuilding.message,
          });
          const retryMs = (indexBuilding.retryAfter || 5) * 1000 || WALLET_INDEX_RETRY_MS;
          await wait(retryMs);
          if (requestId !== currentRequestId) return;
          continue;
        }
        if (!response.ok) {
          apply({
            type: "fetch-failed",
            requestId,
            error: response.statusText || "Failed to load tainted wallets",
          });
          return;
        }
        if (!data || !Array.isArray(data.wallets)) throw new Error("Invalid JSON wallet response");
        apply({
          type: "fetch-succeeded",
          requestId,
          wallets: data?.wallets || [],
          nextCursor: data?.nextCursor || null,
          scanned: data?.scanned,
          hasMore: data?.hasMore,
          append,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
    } catch (error) {
      if (requestId !== currentRequestId) return;
      if (isAbortError(error) && !timeoutSignal.aborted) return;
      apply({
        type: "fetch-failed",
        requestId,
        error: timeoutSignal.aborted
          ? "Loading wallets timed out. Please try again."
          : error.message || "Failed to load tainted wallets",
      });
    }
  }

  function abort() {
    currentRequestId += 1;
    if (controller) controller.abort();
  }

  return { load, abort };
}

export function createWalletsRefreshScheduler({
  intervalMs = WALLETS_AUTO_REFRESH_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  isVisible = () => true,
  onRefresh,
  getState = () => ({}),
} = {}) {
  let timer = null;
  let stopped = true;

  function clear() {
    if (timer != null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function tick() {
    if (stopped) return;
    const state = getState() || {};
    if (
      shouldRefreshWalletsSnapshot({
        loading: state.loading,
        visible: isVisible(),
        mounted: true,
        indexBuilding: Boolean(state.indexBuilding),
      })
    ) {
      onRefresh();
    }
    schedule();
  }

  function schedule() {
    clear();
    if (stopped) return;
    timer = setTimeoutImpl(tick, intervalMs);
  }

  function start() {
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    clear();
  }

  return { start, stop };
}
