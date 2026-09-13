const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
process.env.BITCOIN_RPC_USER = 'test';
process.env.BITCOIN_RPC_PASS = 'test';
const { DatabaseService } = require('../src/services/dbService');
const { BackgroundSyncService } = require('../src/services/backgroundSyncService');
const key = (address, degree) => `h:${String(degree).padStart(16, '0')}:${address}`;
const record = d => ({d,p:'seed',t:'tx',n:1,o:'seed'});

test('DB write lock serializes callers and releases after rejection', async () => {
  const db = new DatabaseService({ environment: {} });
  let unlock;
  const wait = new Promise(r=>{unlock=r;});
  const order=[];
  const first=db.withWriteLock(async()=>{order.push('first');await wait;throw new Error('fail');});
  const failed=assert.rejects(first,/fail/);
  const second=db.withWriteLock(async()=>{order.push('second');return 2;});
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(order,['first']);unlock();
  await failed;assert.equal(await second,2);assert.deepEqual(order,['first','second']);
});

test('wallet updates replace the old hop index in the same atomic batch', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbs-hop-write-'));
  const service=new DatabaseService({dbPath:dir,environment:{},logger:{info(){}}});
  try {
    await service.init();
    await service.updateTaintedInfo('alice',record(5));
    assert.equal(await service.db.get(key('alice',5)),1);
    await service.updateTaintedInfo('alice',record(2));
    assert.equal(await service.db.get(key('alice',5)),undefined);
    assert.equal(await service.db.get(key('alice',2)),1);
    assert.equal((await service.db.get('a:alice')).d,2);
  } finally {await service.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('hop index keys sort numerically and reject invalid degrees', () => {
  const { walletHopIndexKey } = require('../src/services/walletIndexKeys');
  assert.ok(walletHopIndexKey('alice', 2) < walletHopIndexKey('alice', 10));
  assert.ok(walletHopIndexKey('alice', 0) < walletHopIndexKey('alice', 1));
  for (const d of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => walletHopIndexKey('alice', d), /safe integer/);
  }
  assert.throws(() => walletHopIndexKey('a:lice', 1), /address/);
});

test('failed sync commit leaves the old hop index and checkpoint unchanged', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbs-hop-fail-'));
  const store=new DatabaseService({dbPath:dir,environment:{},logger:{info(){}}});
  try {
    const db=await store.init();
    const before={lastBlock:19,blockHash:'hash19',schemaVersion:4};
    await db.batch([{type:'put',key:'a:alice',value:record(7)}, {type:'put',key:key('alice',7),value:1},
      {type:'put',key:'u:parent:0',value:{...record(0),a:'seed'}}, {type:'put',key:'scan_progress',value:before}]);
    const sync=new BackgroundSyncService({dbService:store,logger:{info(){},error(){}},satoshiAddresses:['seed'],bitcoinRPC:{
      async getBlocksWindow(){return [{height:20,hash:'hash20',block:{tx:[{txid:'child',vin:[{txid:'parent',vout:0}],vout:[{value:1,scriptPubKey:{address:'alice'}}]}]}}];},
      getAddressFromScript(script){return script.address;}
    }});
    store.withWriteLock=async()=>{throw new Error('injected batch failure');};
    await assert.rejects(sync.syncNewBlocks(20,20,db),/injected batch failure/);
    assert.equal(await db.get(key('alice',7)),1);
    assert.equal(await db.get(key('alice',1)),undefined);
    assert.deepEqual(await db.get('scan_progress'),before);
    assert.equal((await db.get('a:alice')).d,7);
  } finally {await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('sync hop improvements and new wallets are indexed with the checkpoint', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbs-hop-sync-'));
  const store=new DatabaseService({dbPath:dir,environment:{},logger:{info(){}}});
  try {
    const db=await store.init();
    await db.batch([{type:'put',key:'a:alice',value:record(7)},{type:'put',key:key('alice',7),value:1},
      {type:'put',key:'u:parent:0',value:{...record(0),a:'seed'}}]);
    const sync=new BackgroundSyncService({dbService:store,logger:{info(){},error(){}},satoshiAddresses:['seed'],bitcoinRPC:{
      async getBlocksWindow(){return [{height:20,hash:'hash20',block:{tx:[{txid:'child',vin:[{txid:'parent',vout:0}],vout:[{value:1,scriptPubKey:{address:'alice'}},{value:1,scriptPubKey:{address:'bob'}}]}]}}];},
      getAddressFromScript(script){return script.address;}
    }});
    await sync.syncNewBlocks(20,20,db);
    assert.equal(await db.get(key('alice',7)),undefined);
    assert.equal(await db.get(key('alice',1)),1);
    assert.equal(await db.get(key('bob',1)),1);
    assert.equal((await db.get('scan_progress')).lastBlock,20);
    assert.equal((await db.get('a:alice')).d,1);
  } finally {await store.close();await fs.rm(dir,{recursive:true,force:true});}
});
