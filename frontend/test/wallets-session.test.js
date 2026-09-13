const test = require("node:test");
const assert = require("node:assert/strict");

async function loadSession() {
  return import("../src/utils/walletsSession.mjs");
}

function jsonResponse(body, ok = true, extras = {}) {
  return {
    ok,
    status: extras.status ?? (ok ? 200 : 500),
    statusText: extras.statusText ?? (ok ? "OK" : "Server Error"),
    json: async () => body,
    ...extras,
  };
}

function seededSession(overrides = {}) {
  return {
    wallets: [{ address: "1OLD", hops: 2 }],
    nextCursor: "1OLD",
    pendingCursor: null,
    appliedQuery: "1A",
    draftQuery: "1A",
    sort: "address-asc",
    draftMinHops: "2",
    draftMaxHops: "4",
    minHops: 2,
    maxHops: 4,
    error: null,
    loading: false,
    requestId: 4,
    autoContinues: 2,
    scanned: 50,
    indexBuilding: null,
    updatedAt: "2026-09-13T11:00:00.000Z",
    ...overrides,
  };
}

test("search changes clear the list and cursor before the replacement page arrives", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  const seeded = {
    ...createInitialWalletsSession(),
    wallets: [{ address: "1OLD", hops: 2 }],
    nextCursor: "1OLD",
    appliedQuery: "",
    draftQuery: "1NEW",
  };

  const next = reduceWalletsSession(seeded, {
    type: "submit-search",
    query: "1NEW",
  });

  assert.deepEqual(next.wallets, []);
  assert.equal(next.nextCursor, null);
  assert.equal(next.appliedQuery, "1NEW");
  assert.equal(next.error, null);
  assert.equal(next.loading, true);
  assert.equal(next.autoContinues, 0);
});

test("changing sort or hop range resets wallets and cursor instead of filtering the previously loaded list", async () => {
  const { reduceWalletsSession } = await loadSession();
  const seeded = seededSession();

  const sorted = reduceWalletsSession(seeded, { type: "set-sort", sort: "hops-desc" });
  assert.deepEqual(sorted.wallets, []);
  assert.equal(sorted.nextCursor, null);
  assert.equal(sorted.pendingCursor, null);
  assert.equal(sorted.sort, "hops-desc");
  assert.equal(sorted.appliedQuery, "1A");
  assert.equal(sorted.minHops, 2);
  assert.equal(sorted.maxHops, 4);
  assert.equal(sorted.loading, true);
  assert.equal(sorted.autoContinues, 0);
  assert.equal(sorted.updatedAt, null);

  const ranged = reduceWalletsSession(seeded, {
    type: "apply-hop-range",
    minHops: 0,
    maxHops: 10,
  });
  assert.deepEqual(ranged.wallets, []);
  assert.equal(ranged.nextCursor, null);
  assert.equal(ranged.minHops, 0);
  assert.equal(ranged.maxHops, 10);
  assert.equal(ranged.sort, "address-asc");
  assert.equal(ranged.appliedQuery, "1A");
  assert.equal(ranged.loading, true);
});

test("snapshot refresh preserves applied filters and replaces the first page without appending mixed snapshots", async () => {
  const { reduceWalletsSession } = await loadSession();
  const seeded = seededSession({
    wallets: [
      { address: "1OLD", hops: 2 },
      { address: "1MORE", hops: 3 },
    ],
    nextCursor: "1MORE",
    autoContinues: 3,
  });

  const refreshing = reduceWalletsSession(seeded, { type: "refresh-snapshot" });
  assert.deepEqual(refreshing.wallets, []);
  assert.equal(refreshing.nextCursor, null);
  assert.equal(refreshing.pendingCursor, null);
  assert.equal(refreshing.appliedQuery, "1A");
  assert.equal(refreshing.sort, "address-asc");
  assert.equal(refreshing.minHops, 2);
  assert.equal(refreshing.maxHops, 4);
  assert.equal(refreshing.loading, true);
  assert.equal(refreshing.autoContinues, 0);

  const replaced = reduceWalletsSession(
    { ...refreshing, requestId: 9 },
    {
      type: "fetch-succeeded",
      requestId: 9,
      wallets: [{ address: "1NEW", hops: 2 }],
      nextCursor: "1NEW",
      scanned: 50,
      append: false,
      updatedAt: "2026-09-13T12:00:00.000Z",
    }
  );
  assert.deepEqual(replaced.wallets, [{ address: "1NEW", hops: 2 }]);
  assert.equal(replaced.nextCursor, "1NEW");
  assert.equal(replaced.updatedAt, "2026-09-13T12:00:00.000Z");
});

test("reset restores defaults and clears loaded results so a fresh first page can load", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  const dirty = {
    ...createInitialWalletsSession(),
    appliedQuery: "1A",
    draftQuery: "1A",
    sort: "hops-desc",
    draftMinHops: "2",
    draftMaxHops: "4",
    minHops: 2,
    maxHops: 4,
    wallets: [{ address: "1A", hops: 3 }],
    nextCursor: "1A",
    error: "boom",
  };

  const next = reduceWalletsSession(dirty, { type: "reset" });

  assert.deepEqual(next, {
    ...createInitialWalletsSession(),
    loading: true,
  });
});

test("successful first page replaces results and records the next cursor", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  const loading = reduceWalletsSession(createInitialWalletsSession(), {
    type: "fetch-started",
    requestId: 1,
  });

  const next = reduceWalletsSession(loading, {
    type: "fetch-succeeded",
    requestId: 1,
    wallets: [{ address: "1AAA", hops: 1 }],
    nextCursor: "1AAA",
    append: false,
  });

  assert.equal(next.loading, false);
  assert.equal(next.error, null);
  assert.equal(next.nextCursor, "1AAA");
  assert.deepEqual(next.wallets, [{ address: "1AAA", hops: 1 }]);
});

test("load more appends and dedupes without dropping the previous cursor on later failure", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  let state = {
    ...createInitialWalletsSession(),
    wallets: [{ address: "1AAA", hops: 1 }],
    nextCursor: "1AAA",
  };

  state = reduceWalletsSession(state, { type: "load-more" });
  assert.equal(state.loading, true);
  assert.equal(state.pendingCursor, "1AAA");
  assert.equal(state.nextCursor, "1AAA");
  assert.deepEqual(state.wallets, [{ address: "1AAA", hops: 1 }]);

  state = reduceWalletsSession(state, {
    type: "fetch-started",
    requestId: 2,
  });
  state = reduceWalletsSession(state, {
    type: "fetch-succeeded",
    requestId: 2,
    wallets: [
      { address: "1AAA", hops: 99 },
      { address: "1BBB", hops: 2 },
    ],
    nextCursor: "1BBB",
    append: true,
  });

  assert.deepEqual(state.wallets, [
    { address: "1AAA", hops: 1 },
    { address: "1BBB", hops: 2 },
  ]);
  assert.equal(state.nextCursor, "1BBB");
  assert.equal(state.pendingCursor, null);

  state = reduceWalletsSession(state, { type: "load-more" });
  state = reduceWalletsSession(state, {
    type: "fetch-started",
    requestId: 3,
  });
  state = reduceWalletsSession(state, {
    type: "fetch-failed",
    requestId: 3,
    error: "Failed to load tainted wallets",
  });

  assert.equal(state.loading, false);
  assert.equal(state.error, "Failed to load tainted wallets");
  assert.equal(state.nextCursor, "1BBB");
  assert.equal(state.pendingCursor, null);
  assert.deepEqual(
    state.wallets.map((wallet) => wallet.address),
    ["1AAA", "1BBB"]
  );

  const retry = reduceWalletsSession(state, { type: "load-more" });
  assert.equal(retry.pendingCursor, "1BBB");
});

test("stale and aborted responses do not replace a newer session", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  let state = reduceWalletsSession(createInitialWalletsSession(), {
    type: "fetch-started",
    requestId: 2,
  });

  state = reduceWalletsSession(state, {
    type: "fetch-succeeded",
    requestId: 1,
    wallets: [{ address: "stale", hops: 0 }],
    nextCursor: "stale",
    append: false,
  });
  assert.deepEqual(state.wallets, []);
  assert.equal(state.loading, true);

  state = reduceWalletsSession(state, {
    type: "fetch-failed",
    requestId: 1,
    error: "old failure",
    aborted: true,
  });
  assert.equal(state.error, null);
  assert.equal(state.loading, true);
});

test("abortable loader times out, aborts in-flight work, and ignores stale JSON", async () => {
  const { createWalletsLoader } = await loadSession();
  const calls = [];
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const fetchImpl = async (url, options) => {
    calls.push({ url, aborted: options.signal.aborted });
    if (calls.length === 1) {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        resolveFirst(Promise.reject(error));
      });
      return first;
    }
    return jsonResponse({
      wallets: [{ address: "1NEW", hops: 1 }],
      nextCursor: null,
    });
  };

  const applied = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 20,
  });

  const firstLoad = loader.load({ q: "old", apply: (event) => applied.push(event) });
  const secondLoad = loader.load({ q: "1NEW", apply: (event) => applied.push(event) });

  await Promise.allSettled([firstLoad, secondLoad]);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /q=old/);
  assert.match(calls[1].url, /q=1NEW/);
  const terminal = applied.filter((event) => event.type !== "fetch-started");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "fetch-succeeded");
  assert.deepEqual(terminal[0].wallets, [{ address: "1NEW", hops: 1 }]);
  assert.equal(terminal[0].append, false);
});

test("loader load-more keeps the same cursor after a failed page so retry is possible", async () => {
  const { createWalletsLoader } = await loadSession();
  let attempt = 0;
  const fetchImpl = async (url) => {
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("network down");
      throw error;
    }
    assert.match(url, /cursor=1AAA/);
    return jsonResponse({
      wallets: [{ address: "1BBB", hops: 2 }],
      nextCursor: "1BBB",
    });
  };

  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 1000,
  });
  const applied = [];
  const apply = (event) => applied.push(event);

  await loader.load({ cursor: "1AAA", append: true, apply });
  await loader.load({ cursor: "1AAA", append: true, apply });

  const terminal = applied.filter((event) => event.type !== "fetch-started");
  assert.equal(terminal[0].type, "fetch-failed");
  assert.equal(terminal[1].type, "fetch-succeeded");
  assert.equal(terminal[1].append, true);
  assert.equal(terminal[1].nextCursor, "1BBB");
});

test("a timed-out fetch reporting AbortError exits loading and permits retry", async () => {
  const { createWalletsLoader } = await loadSession();
  const actions = [];
  const keepAlive = setTimeout(() => {}, 1000);
  const loader = createWalletsLoader({
    apiUrl: "https://test.invalid",
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  });
  try {
    await loader.load({ apply: action => actions.push(action) });
    assert.equal(actions.at(-1).type, "fetch-failed");
    assert.match(actions.at(-1).error, /timed out/i);
  } finally {
    loader.abort();
    clearTimeout(keepAlive);
  }
});

test("loader cleanup abort suppresses the in-flight apply callback", async () => {
  const { createWalletsLoader } = await loadSession();
  let resolveFetch;
  const fetchImpl = () =>
    new Promise((resolve, reject) => {
      resolveFetch = { resolve, reject };
    });

  const applied = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 5000,
  });

  const pending = loader.load({ apply: (event) => applied.push(event) });
  loader.abort();
  resolveFetch.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await pending;

  assert.equal(
    applied.some((event) => event.type === "fetch-succeeded" || event.type === "fetch-failed"),
    false
  );
});

test("successful pages keep server order, scanned, and hasMore without local resort", async () => {
  const { reduceWalletsSession, createInitialWalletsSession } = await loadSession();
  const loading = reduceWalletsSession(createInitialWalletsSession(), {
    type: "fetch-started",
    requestId: 1,
  });
  const serverOrder = [
    { address: "bc1qaaa", hops: 1 },
    { address: "1BBB", hops: 1 },
  ];

  const next = reduceWalletsSession(loading, {
    type: "fetch-succeeded",
    requestId: 1,
    wallets: serverOrder,
    nextCursor: "OPAQUE",
    scanned: 50,
    hasMore: true,
    append: false,
    updatedAt: "2026-09-13T12:00:00.000Z",
  });

  assert.deepEqual(
    next.wallets.map((wallet) => wallet.address),
    ["bc1qaaa", "1BBB"]
  );
  assert.equal(next.scanned, 50);
  assert.equal(next.hasMore, true);
  assert.equal(next.updatedAt, "2026-09-13T12:00:00.000Z");
  assert.equal(next.indexBuilding, null);
});

test("empty global pages with a cursor increment auto-continues until the bound then stay explicit", async () => {
  const { reduceWalletsSession } = await loadSession();
  let state = seededSession({
    wallets: [],
    nextCursor: "c0",
    autoContinues: 0,
    loading: false,
  });

  state = reduceWalletsSession(state, { type: "auto-continue" });
  assert.equal(state.autoContinues, 1);
  assert.equal(state.pendingCursor, "c0");
  assert.equal(state.loading, true);
  assert.equal(state.nextCursor, "c0");

  state = reduceWalletsSession(state, {
    type: "fetch-succeeded",
    requestId: state.requestId,
    wallets: [],
    nextCursor: "c1",
    scanned: 50,
    append: true,
  });
  assert.deepEqual(state.wallets, []);
  assert.equal(state.nextCursor, "c1");
});

test("WALLET_INDEX_BUILDING keeps an honest progress state instead of falling back locally", async () => {
  const { reduceWalletsSession } = await loadSession();
  const loading = {
    ...seededSession({ wallets: [], nextCursor: null, loading: true, requestId: 7 }),
  };

  const next = reduceWalletsSession(loading, {
    type: "index-building",
    requestId: 7,
    retryAfter: 5,
    index: { ready: false, phase: "building", indexed: 12, total: 100 },
    message: "Wallet hop index is still building",
  });

  assert.equal(next.loading, true);
  assert.equal(next.error, null);
  assert.deepEqual(next.indexBuilding, {
    ready: false,
    phase: "building",
    indexed: 12,
    total: 100,
  });
  assert.equal(next.retryAfter, 5);
  assert.deepEqual(next.wallets, []);
});

test("loader sends global sort and hop bounds and records server order pass-through", async () => {
  const { createWalletsLoader } = await loadSession();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({
      wallets: [
        { address: "bc1qaaa", hops: 4 },
        { address: "1BBB", hops: 1 },
      ],
      nextCursor: "OPAQUE",
      hasMore: true,
      scanned: 50,
    });
  };

  const applied = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 1000,
  });

  await loader.load({
    q: "bc1Q",
    sort: "hops-desc",
    minHops: 0,
    maxHops: 10,
    apply: (event) => applied.push(event),
  });

  assert.match(calls[0], /limit=50/);
  assert.match(calls[0], /q=bc1Q/);
  assert.match(calls[0], /sort=hops-desc/);
  assert.match(calls[0], /minHops=0/);
  assert.match(calls[0], /maxHops=10/);
  const success = applied.find((event) => event.type === "fetch-succeeded");
  assert.deepEqual(
    success.wallets.map((wallet) => wallet.address),
    ["bc1qaaa", "1BBB"]
  );
  assert.equal(success.nextCursor, "OPAQUE");
  assert.equal(success.scanned, 50);
  assert.equal(success.hasMore, true);
});

test("loader polls WALLET_INDEX_BUILDING every 5s until ready and abort cleanup stops the loop", async () => {
  const { createWalletsLoader } = await loadSession();
  const calls = [];
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    calls.push(attempt);
    if (attempt < 3) {
      return jsonResponse(
        {
          error: "WALLET_INDEX_BUILDING",
          message: "Wallet hop index is still building",
          index: { ready: false, phase: "building", indexed: attempt, total: 10 },
          retryAfter: 5,
        },
        false,
        { status: 503, statusText: "Service Unavailable" }
      );
    }
    return jsonResponse({
      wallets: [{ address: "1AAA", hops: 1 }],
      nextCursor: null,
      scanned: 1,
    });
  };

  const applied = [];
  const delays = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 1000,
    now: () => 0,
    wait: async (ms) => {
      delays.push(ms);
    },
  });

  await loader.load({ apply: (event) => applied.push(event) });

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [5000, 5000]);
  assert.equal(
    applied.filter((event) => event.type === "index-building").length,
    2
  );
  const success = applied.find((event) => event.type === "fetch-succeeded");
  assert.deepEqual(success.wallets, [{ address: "1AAA", hops: 1 }]);
});

test("index-building retries keep a fresh per-request timeout so long polling is not aborted at 15s", async () => {
  const { createWalletsLoader } = await loadSession();
  const signals = [];
  let attempt = 0;
  let now = 0;
  const fetchImpl = async (_url, { signal }) => {
    attempt += 1;
    signals.push(signal);
    assert.equal(signal.aborted, false);
    if (attempt < 4) {
      return jsonResponse(
        {
          error: "WALLET_INDEX_BUILDING",
          message: "building",
          index: { ready: false, phase: "building", indexed: attempt, total: 10 },
          retryAfter: 5,
        },
        false,
        { status: 503 }
      );
    }
    return jsonResponse({
      wallets: [{ address: "1AAA", hops: 1 }],
      nextCursor: null,
      scanned: 1,
    });
  };

  const applied = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 15_000,
    wait: async (ms) => {
      now += ms;
    },
  });

  await loader.load({ apply: (event) => applied.push(event) });

  assert.ok(now >= 15_000);
  assert.equal(signals.length, 4);
  assert.equal(signals[0] === signals[3], false);
  const success = applied.find((event) => event.type === "fetch-succeeded");
  assert.deepEqual(success.wallets, [{ address: "1AAA", hops: 1 }]);
  assert.equal(applied.some((event) => event.type === "fetch-failed"), false);
});

test("malformed JSON on a 200 response fails instead of showing an empty wallet list", async () => {
  const { createWalletsLoader } = await loadSession();
  const applied = [];
  const loader = createWalletsLoader({
    apiUrl: "http://localhost:3001",
    timeoutMs: 1000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }),
  });

  await loader.load({ apply: (event) => applied.push(event) });
  const terminal = applied.filter((event) => event.type !== "fetch-started");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "fetch-failed");
  assert.match(terminal[0].error, /failed to load tainted wallets|invalid json|unexpected/i);
});

test("index-building poll abort cleanup does not start an obsolete retry loop", async () => {
  const { createWalletsLoader } = await loadSession();
  let resolveWait;
  const fetchImpl = async () =>
    jsonResponse(
      {
        error: "WALLET_INDEX_BUILDING",
        message: "building",
        index: { ready: false, phase: "building", indexed: 1, total: 10 },
        retryAfter: 5,
      },
      false,
      { status: 503 }
    );

  const applied = [];
  const loader = createWalletsLoader({
    fetchImpl,
    apiUrl: "http://localhost:3001",
    timeoutMs: 1000,
    wait: () =>
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
  });

  const pending = loader.load({ apply: (event) => applied.push(event) });
  await new Promise((resolve) => setImmediate(resolve));
  loader.abort();
  if (resolveWait) resolveWait();
  await pending;

  assert.equal(applied.some((event) => event.type === "fetch-succeeded"), false);
  assert.equal(applied.some((event) => event.type === "fetch-failed"), false);
});

test("snapshot refresh scheduler fires only on a visible idle tab and can be cleared", async () => {
  const { createWalletsRefreshScheduler, WALLETS_AUTO_REFRESH_MS } = await loadSession();
  const ticks = [];
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const scheduler = createWalletsRefreshScheduler({
    intervalMs: WALLETS_AUTO_REFRESH_MS,
    now: () => now,
    setTimeoutImpl: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeoutImpl: (id) => {
      timers.delete(id);
    },
    isVisible: () => true,
    onRefresh: () => ticks.push(now),
  });

  scheduler.start();
  now = 60000;
  for (const timer of [...timers.values()]) timer.fn();
  assert.deepEqual(ticks, [60000]);

  scheduler.stop();
  now = 120000;
  for (const timer of [...timers.values()]) timer.fn();
  assert.deepEqual(ticks, [60000]);
});

test("snapshot refresh scheduler skips hidden tabs and loading or index-building sessions", async () => {
  const { createWalletsRefreshScheduler } = await loadSession();
  const ticks = [];
  const timers = new Map();
  let nextId = 1;
  let visible = false;
  let state = { loading: false, indexBuilding: null };
  const scheduler = createWalletsRefreshScheduler({
    intervalMs: 60000,
    setTimeoutImpl: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeoutImpl: (id) => {
      timers.delete(id);
    },
    isVisible: () => visible,
    getState: () => state,
    onRefresh: () => ticks.push("tick"),
  });

  scheduler.start();
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(ticks, []);

  visible = true;
  state = { loading: true, indexBuilding: null };
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(ticks, []);

  state = { loading: false, indexBuilding: { ready: false } };
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(ticks, []);

  state = { loading: false, indexBuilding: null };
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(ticks, ["tick"]);
  scheduler.stop();
});
