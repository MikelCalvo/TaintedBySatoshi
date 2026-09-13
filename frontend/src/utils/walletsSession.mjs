import {
  WALLET_PAGE_SIZE,
  WALLETS_FETCH_TIMEOUT_MS,
  buildWalletsRequestUrl,
  mergeWalletPages,
  normalizeSearchQuery,
} from "./walletsExplorer.mjs";

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
      return { ...state, sort: action.sort };
    case "apply-hop-range":
      return {
        ...state,
        minHops: action.minHops ?? null,
        maxHops: action.maxHops ?? null,
      };
    case "submit-search": {
      const query = normalizeSearchQuery(action.query);
      return {
        ...state,
        wallets: [],
        nextCursor: null,
        pendingCursor: null,
        appliedQuery: query,
        draftQuery: query,
        error: null,
        loading: true,
      };
    }
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
      };
    case "fetch-failed":
      if (action.aborted || action.requestId !== state.requestId) return state;
      return {
        ...state,
        loading: false,
        error: action.error || "Failed to load tainted wallets",
        pendingCursor: null,
      };
    default:
      return state;
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

export function createWalletsLoader({
  fetchImpl = fetch,
  apiUrl,
  timeoutMs = WALLETS_FETCH_TIMEOUT_MS,
  limit = WALLET_PAGE_SIZE,
} = {}) {
  let controller = null;
  let currentRequestId = 0;

  async function load({
    q,
    cursor,
    append = false,
    apply = () => {},
  } = {}) {
    if (controller) controller.abort();
    controller = new AbortController();
    const requestId = ++currentRequestId;
    apply({ type: "fetch-started", requestId });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    const url = buildWalletsRequestUrl(apiUrl, { limit, q, cursor });

    try {
      const response = await fetchImpl(url, { signal });
      if (requestId !== currentRequestId) return;
      if (!response.ok) {
        apply({
          type: "fetch-failed",
          requestId,
          error: response.statusText || "Failed to load tainted wallets",
        });
        return;
      }
      const data = await response.json();
      if (requestId !== currentRequestId) return;
      apply({
        type: "fetch-succeeded",
        requestId,
        wallets: data.wallets || [],
        nextCursor: data.nextCursor || null,
        append,
      });
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
