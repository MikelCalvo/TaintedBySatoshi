const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('HTTP bootstrap starts the wallet index only after sync initialization', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  const sync=source.indexOf('await backgroundSyncService.start()');
  const index=source.indexOf('await walletIndexService.ensureStarted()',sync);
  assert.ok(sync>=0 && index>sync,'Index start must follow seed/database initialization');
  assert.match(source,/walletIndex:\s*walletIndexService\.getStatus\(\)/);
});

test('shutdown stops the index worker before closing the shared database', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  const index=source.indexOf('await walletIndexService.stop()');
  const sync=source.indexOf('await backgroundSyncService.stop()');
  assert.ok(index>=0 && sync>index,'Stop backfill before sync closes shared DB');
});

test('shutdown requests sync stop immediately, before HTTP close or index stop', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  const flag=source.indexOf('shuttingDown = true');
  const request=source.indexOf('backgroundSyncService.requestStop()', flag);
  const close=source.indexOf('server.close', flag);
  const index=source.indexOf('await walletIndexService.stop()', flag);
  const stop=source.indexOf('await backgroundSyncService.stop()', flag);
  assert.ok(flag>=0 && request>flag, 'requestStop must run after shutdown begins');
  assert.ok(request<close, 'requestStop must not wait for HTTP server.close');
  assert.ok(index>request && stop>index, 'requestStop then index stop then sync.stop');
});

test('process shutdown budget is long enough for an in-flight sync window', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  assert.match(source, /setTimeout\(\(\) => process\.exit\(1\), 1200000\)/);
});

test('backend PM2 kill_timeout allows a 20 minute graceful stop', () => {
  const config=require('../../ecosystem.config.js');
  const backend=config.apps.find((app) => app.name==='TaintedBySatoshi_backend');
  assert.equal(backend.kill_timeout, 1200000);
});
