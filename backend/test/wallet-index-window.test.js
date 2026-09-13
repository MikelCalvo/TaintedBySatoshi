const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
process.env.BITCOIN_RPC_USER='test';process.env.BITCOIN_RPC_PASS='test';
const {DatabaseService}=require('../src/services/dbService');
const {BackgroundSyncService}=require('../src/services/backgroundSyncService');
const {walletHopIndexKey:h}=require('../src/services/walletIndexKeys');

test('multiple hop improvements within one window leave only the final global index key',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tbs-window-hop-'));
 const store=new DatabaseService({dbPath:dir,environment:{},logger:{info(){}}});
 try{
  const db=await store.init();
  const rec=d=>({d,p:'seed',t:'tx',n:1,o:'seed'});
  await db.batch([{type:'put',key:'a:alice',value:rec(8)},{type:'put',key:h('alice',8),value:1},
    {type:'put',key:'u:parent5:0',value:{...rec(4),a:'parent5'}},{type:'put',key:'u:parent2:0',value:{...rec(1),a:'parent2'}}]);
  const blocks=[5,2].map((d,i)=>({height:20+i,hash:`hash${20+i}`,block:{tx:[{txid:`child${d}`,vin:[{txid:`parent${d}`,vout:0}],vout:[{value:1,scriptPubKey:{address:'alice'}}]}]}}));
  const sync=new BackgroundSyncService({dbService:store,satoshiAddresses:['seed'],logger:{info(){},error(){}},bitcoinRPC:{async getBlocksWindow(){return blocks;},getAddressFromScript(s){return s.address;}}});
  await sync.syncNewBlocks(20,21,db);
  assert.equal((await db.get('a:alice')).d,2);
  assert.equal(await db.get(h('alice',8)),undefined);
  assert.equal(await db.get(h('alice',5)),undefined);
  assert.equal(await db.get(h('alice',2)),1);
  assert.equal((await db.get('scan_progress')).lastBlock,21);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('same-hop refresh then later improvements tombstone the durable hop index',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tbs-window-hop-same-'));
 const store=new DatabaseService({dbPath:dir,environment:{},logger:{info(){}}});
 try{
  const db=await store.init();
  const rec=d=>({d,p:'seed',t:'tx',n:1,o:'seed'});
  await db.batch([{type:'put',key:'a:alice',value:rec(8)},{type:'put',key:h('alice',8),value:1},
    {type:'put',key:'u:parent8:0',value:{...rec(7),a:'parent8'}},{type:'put',key:'u:parent5:0',value:{...rec(4),a:'parent5'}},{type:'put',key:'u:parent2:0',value:{...rec(1),a:'parent2'}}]);
  const blocks=[8,5,2].map((d,i)=>({height:20+i,hash:`hash${20+i}`,block:{tx:[{txid:`child${d}`,vin:[{txid:`parent${d}`,vout:0}],vout:[{value:1,scriptPubKey:{address:'alice'}}]}]}}));
  const sync=new BackgroundSyncService({dbService:store,satoshiAddresses:['seed'],logger:{info(){},error(){}},bitcoinRPC:{async getBlocksWindow(){return blocks;},getAddressFromScript(s){return s.address;}}});
  await sync.syncNewBlocks(20,22,db);
  assert.equal((await db.get('a:alice')).d,2);
  assert.equal(await db.get(h('alice',8)),undefined);
  assert.equal(await db.get(h('alice',5)),undefined);
  assert.equal(await db.get(h('alice',2)),1);
  assert.equal((await db.get('scan_progress')).lastBlock,22);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
