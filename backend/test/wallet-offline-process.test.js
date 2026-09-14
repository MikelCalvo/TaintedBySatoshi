const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Level } = require('level');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real HTTP process survives failed RPC startup and serves its persisted wallet index', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tbs-offline-process-'));
  let child;
  let exited;
  let output = '';
  try {
    const database = path.join(dir, 'db');
    const db = new Level(database, { valueEncoding: 'json' });
    await db.batch([
      { type: 'put', key: 'a:1test', value: { d: 0 } },
      { type: 'put', key: 'h:0000000000000000:1test', value: 1 },
      { type: 'put', key: 'wallet_hop_index', value: { version: 1, complete: true, indexed: 1, cursor: null } },
      { type: 'put', key: 'scan_progress', value: { schemaVersion: 4, height: 100, taintedWallets: 1 } },
    ]);
    await db.close();
    const port = await freePort();
    const rpcPort = await freePort();
    child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: database,
        BITCOIN_RPC_HOST: '127.0.0.1', BITCOIN_RPC_PORT: String(rpcPort),
        BITCOIN_RPC_USER: 'offline-test', BITCOIN_RPC_PASS: 'offline-test', BITCOIN_RPC_TIMEOUT: '100',
        ANALYTICS_ENABLED: 'false', ANALYTICS_DB_PATH: path.join(dir, 'analytics') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise(resolve => child.once('exit', resolve));
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let state;
    for (let i = 0; i < 60; i += 1) {
      assert.equal(child.exitCode, null, `HTTP process exited during RPC outage: ${output}`);
      try {
        state = await fetch(`${base}/api/sync-status`, { signal: AbortSignal.timeout(300) }).then(r => r.json());
        if (state.phase === 'failed') break;
      } catch { /* startup has not listened yet */ }
      await delay(50);
    }
    assert.equal(state?.phase, 'failed', output);
    assert.ok(state.lastError);
    assert.equal(state.walletIndex.ready, true);
    const response = await fetch(`${base}/api/wallets?sort=hops-asc&limit=20`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.wallets.map(w => [w.address, w.hops]), [['1test', 0]]);
    assert.equal(page.hasMore, false);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/readiness`)).status, 503);
    assert.equal(child.exitCode, null);
  } finally {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode == null) { child.kill('SIGKILL'); await exited; }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
