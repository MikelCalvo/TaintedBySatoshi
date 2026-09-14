const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Level } = require('level');
const { WalletIndexService } = require('../src/services/walletIndexService');
const logger = { info() {}, warn() {}, error() {} };

async function withIndex(marker, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tbs-index-offline-'));
  const db = new Level(dir, { valueEncoding: 'json' });
  try {
    await db.open();
    if (marker) await db.put('wallet_hop_index', marker);
    await db.put('scan_progress', { schemaVersion: 4, height: 100, taintedWallets: 42 });
    const service = new WalletIndexService({ dbService: { init: async () => db }, logger });
    db.batch = () => { throw new Error('unexpected write'); };
    db.put = () => { throw new Error('unexpected write'); };
    service.runBackfill = () => { throw new Error('unexpected backfill'); };
    await work(service);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('persisted complete index becomes readable without Bitcoin RPC or wallet writes', async () => {
  await withIndex({ version: 1, complete: true, cursor: null, indexed: 40 }, async service => {
    assert.equal(await service.restoreCompleted(), true);
    assert.equal(service.isReady(), true);
    assert.equal(service.getStatus().total, 42);
    assert.equal(service.getStatus().indexed, 40);
    assert.equal(await service.restoreCompleted(), true);
  });
});

test('missing, incomplete and incompatible indexes stay unavailable without a backfill', async () => {
  for (const marker of [null,
    { version: 1, complete: false, cursor: 'a:1aaa', indexed: 1 },
    { version: 0, complete: true, cursor: null, indexed: 40 },
    { version: 1, complete: true, cursor: 'a:1aaa', indexed: 40 },
  ]) {
    await withIndex(marker, async service => {
      assert.equal(await service.restoreCompleted(), false);
      assert.equal(service.isReady(), false);
      assert.equal(service.phase, 'idle');
    });
  }
});
