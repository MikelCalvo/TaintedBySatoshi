const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Level } = require('level');
const { walletHopIndexKey } = require('../src/services/walletIndexKeys');
const { queryWallets } = require('../src/services/walletQueryService');
const { parseWalletListQuery } = require('../src/utils/validation');

async function fixture(records, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tbs-differential-'));
  const db = new Level(dir, { valueEncoding: 'json' });
  try {
    await db.batch(records.flatMap(({ address, d }) => [
      { type: 'put', key: `a:${address}`, value: { d } },
      { type: 'put', key: walletHopIndexKey(address, d), value: 1 },
    ]));
    await work(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkAllPages(db, records, query) {
  const expected = records.filter(r => r.address.startsWith(query.q || '')
    && r.d >= (query.minHops ?? 0) && r.d <= (query.maxHops ?? Number.MAX_SAFE_INTEGER));
  expected.sort((a, b) => {
    const byAddress = a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    const ascending = query.sort.startsWith('hops') ? (a.d - b.d || byAddress) : byAddress;
    return query.sort.endsWith('desc') ? -ascending : ascending;
  });
  const seenCursors = new Set();
  const found = [];
  const pages = [];
  let cursor = null;
  do {
    const page = await queryWallets(db, parseWalletListQuery({ ...query, cursor }));
    assert.ok(page.scanned <= 2000);
    assert.ok(page.wallets.length <= query.limit);
    assert.equal(page.hasMore, Boolean(page.nextCursor));
    if (page.scanLimited) assert.ok(page.nextCursor);
    pages.push(page);
    found.push(...page.wallets);
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seenCursors.has(cursor), 'continuation must advance');
      seenCursors.add(cursor);
    }
    assert.ok(pages.length < 100, 'bounded fixture must terminate');
  } while (cursor);
  assert.deepEqual(found.map(w => [w.address, w.hops]), expected.map(r => [r.address, r.d]), JSON.stringify(query));
  return pages;
}

test('all query plans agree with deterministic mixed-case, tied-hop ground truth', async () => {
  let seed = 20260914;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const prefixes = ['1A', '1a', '3', 'bc1', 'z'];
  const records = Array.from({ length: 700 }, (_, i) => ({
    address: `${prefixes[random(prefixes.length)]}${String(i).padStart(6, '0')}w`,
    d: random(5) === 0 ? Number.MAX_SAFE_INTEGER - random(4) : random(160),
  }));
  await fixture(records, async db => {
    for (const sort of ['hops-asc', 'hops-desc', 'address-asc', 'address-desc']) {
      for (const q of [null, '1', '1A', 'bc1', 'zz']) {
        for (const bounds of [{}, { minHops: 4, maxHops: 12 }, { minHops: 20, maxHops: 120 }]) {
          await checkAllPages(db, records, { sort, q, ...bounds, limit: 17 });
        }
      }
      await checkAllPages(db, records, {
        sort, q: '1', minHops: Number.MAX_SAFE_INTEGER - 3,
        maxHops: Number.MAX_SAFE_INTEGER, limit: 3,
      });
    }
  });
});

test('lazy prefix searches resume empty and underfilled pages in both directions', async () => {
  const records = Array.from({ length: 4800 }, (_, i) => ({
    address: `0${String(i).padStart(6, '0')}w`, d: i + 100,
  }));
  for (let i = 0; i < 80; i += 1) {
    records.push({ address: `zz${String(i).padStart(6, '0')}w`, d: i < 40 ? i : 6000 + i });
  }
  await fixture(records, async db => {
    for (const sort of ['hops-asc', 'hops-desc']) {
      const pages = await checkAllPages(db, records, { sort, q: 'zz', limit: 50 });
      assert.ok(pages.some(p => p.scanLimited && p.wallets.length > 0 && p.wallets.length < 50));
      assert.ok(pages.some(p => p.scanLimited && p.wallets.length === 0));
    }
  });
});

test('max-only narrow hop filters seek buckets rather than scanning unrelated addresses', async () => {
  const records = Array.from({ length: 2200 }, (_, i) => ({
    address: `1${String(i).padStart(6, '0')}w`, d: 100,
  })).concat([{ address: 'zzseed', d: 0 }, { address: 'zzone', d: 1 }]);
  await fixture(records, async db => {
    const page = await queryWallets(db, parseWalletListQuery({ sort: 'address-asc', maxHops: 1, limit: 20 }));
    assert.deepEqual(page.wallets.map(w => w.address), ['zzone', 'zzseed']);
    assert.equal(page.hasMore, false);
    assert.ok(page.scanned <= 25, page.scanned);
  });
});

test('lazy prefix seek finds matches beyond another address in an occupied bucket', async () => {
  const records = Array.from({ length: 45 }, (_, i) => [
    { address: `0${String(i).padStart(6, '0')}w`, d: 10 * i + 4 },
    { address: `zz${String(i).padStart(6, '0')}w`, d: 10 * i + 4 },
  ]).flat();
  await fixture(records, async db => {
    for (const sort of ['hops-asc', 'hops-desc']) {
      await checkAllPages(db, records, { sort, q: 'zz', limit: 7 });
    }
  });
});
