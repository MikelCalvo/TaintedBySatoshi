const test = require("node:test");
const assert = require("node:assert/strict");

async function loadSession() {
  return import("../src/utils/walletsSession.mjs");
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
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
