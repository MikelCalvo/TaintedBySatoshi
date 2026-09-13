const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {Level}=require('level');
const {walletHopIndexKey:h}=require('../src/services/walletIndexKeys');
const {queryWallets}=require('../src/services/walletQueryService');
const {parseWalletListQuery}=require('../src/utils/validation');
async function fixture(work){const dir=await mkdtemp(path.join(os.tmpdir(),'tbs-global-'));const db=new Level(dir,{valueEncoding:'json'});try{const records=Array.from({length:321},(_,i)=>({address:`1${String(i).padStart(6,'0')}abc`,d:(320-i)%11}));await db.batch(records.flatMap(r=>[{type:'put',key:`a:${r.address}`,value:{d:r.d,p:'seed',o:'seed',n:1,t:'tx'}},{type:'put',key:h(r.address,r.d),value:1}]));await work(db,records);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
for(const sort of ['address-asc','address-desc','hops-asc','hops-desc'])test(`global ${sort} combines prefix/range and pages all matching wallets`,()=>fixture(async(db,records)=>{
 const query={sort,q:'1',minHops:2,maxHops:7,limit:17};let cursor=null;const found=[];
 do{const page=await queryWallets(db,parseWalletListQuery({...query,cursor}));found.push(...page.wallets);cursor=page.nextCursor;}while(cursor);
 const reverse=sort.endsWith('desc')?-1:1;const expected=records.filter(r=>r.d>=2&&r.d<=7).sort((a,b)=>reverse*(sort.startsWith('hops')?(a.d-b.d||a.address.localeCompare(b.address)):a.address.localeCompare(b.address)));
 assert.deepEqual(found.map(r=>r.address),expected.map(r=>r.address));assert.equal(new Set(found.map(r=>r.address)).size,found.length);assert.ok(found.length>50);
}));
test('selective full-prefix hop query seeks buckets instead of scanning all rows',()=>fixture(async(db)=>{const page=await queryWallets(db,parseWalletListQuery({q:'100031',sort:'hops-asc',minHops:0,maxHops:10,limit:20}));assert.ok(page.wallets.length>0);assert.ok(page.wallets.every(w=>w.address.startsWith('100031')));assert.ok(page.scanned<80,page.scanned);}));
test('opaque cursor cannot be reused with different global filters',()=>fixture(async(db)=>{const page=await queryWallets(db,parseWalletListQuery({sort:'hops-asc',limit:2}));assert.throws(()=>parseWalletListQuery({sort:'hops-desc',limit:2,cursor:page.nextCursor}),/cursor/i);}));
test('query validates sorts, safe hop bounds and reversed ranges',()=>{for(const q of [{sort:'evil'},{minHops:'1.5'},{minHops:'-1'},{minHops:3,maxHops:1},{maxHops:'9007199254740992'},{sort:['hops-asc']},{cursor:'not-a-cursor'}])assert.throws(()=>parseWalletListQuery(q));});
