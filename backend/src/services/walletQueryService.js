const { encodeWalletCursor } = require('../utils/validation');
const MAX_BUCKETS = 512;
const MAX_READS = 2000;
const degreePrefix = d => `h:${String(d).padStart(16, '0')}:`;
const upperPrefix = p => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const needsHopIndex = q => q.sort.startsWith('hops') || q.minHops != null || q.maxHops != null;

function queryLimit() {
  const error = new Error('Wallet query is too broad. Narrow the hop range or address prefix.');
  error.code = 'WALLET_QUERY_TOO_BROAD';
  return error;
}

async function queryWallets(db, q) {
  const snapshot = db.snapshot();
  const iterators = [];
  let scanned = 0;
  const reverse = q.sort.endsWith('desc');
  const target = q.limit + 1;
  function iterator(options) {
    const it = db.iterator({ ...options, snapshot, fillCache: false, highWaterMarkBytes: 32768 });
    iterators.push(it);
    return it;
  }
  async function next(it) {
    if (++scanned > MAX_READS) throw queryLimit();
    return it.next();
  }
  const entries = [];
  try {
    if (!needsHopIndex(q)) {
      const prefix = `a:${q.q || ''}`;
      const options = { gte: prefix, lt: upperPrefix(prefix), reverse, limit: target };
      if (q.cursor) {
        if (reverse) options.lt = q.cursor;
        else { delete options.gte; options.gt = q.cursor; }
      }
      const it = iterator(options);
      while (entries.length < target) {
        const entry = await next(it);
        if (!entry) break;
        entries.push({ key: entry[0], address: entry[0].slice(2), record: entry[1] });
      }
    } else {
      // Discover occupied degrees with one seek each, never walk whole buckets.
      const min = q.minHops ?? 0;
      const max = q.maxHops ?? Number.MAX_SAFE_INTEGER;
      const discovery = iterator({ gte: degreePrefix(min), lt: upperPrefix(degreePrefix(max)) });
      const degrees = [];
      let entry = await next(discovery);
      while (entry) {
        const d = Number(entry[0].slice(2, 18));
        if (!Number.isSafeInteger(d) || d < min || d > max) break;
        degrees.push(d);
        if (degrees.length > MAX_BUCKETS) throw queryLimit();
        if (d === Number.MAX_SAFE_INTEGER) break;
        discovery.seek(degreePrefix(d + 1));
        entry = await next(discovery);
      }
      await discovery.close();
      if (reverse) degrees.reverse();
      const buckets = [];
      for (const d of degrees) {
        const prefix = `${degreePrefix(d)}${q.q || ''}`;
        const options = { gte: prefix, lt: upperPrefix(prefix), reverse };
        if (q.cursor) {
          if (q.sort.startsWith('hops')) {
            const cursorDegree = Number(q.cursor.slice(2, 18));
            if ((!reverse && d < cursorDegree) || (reverse && d > cursorDegree)) continue;
            if (d === cursorDegree) {
              if (reverse) options.lt = q.cursor;
              else { delete options.gte; options.gt = q.cursor; }
            }
          } else {
            const key = `${degreePrefix(d)}${q.cursor.slice(2)}`;
            if (reverse) options.lt = key;
            else { delete options.gte; options.gt = key; }
          }
        }
        const it = iterator(options);
        const first = await next(it);
        if (first) buckets.push({ it, entry: first, d });
      }
      while (buckets.length && entries.length < target) {
        // With few occupied degrees a linear head merge is cheap and bounded.
        let selected = 0;
        for (let i = 1; i < buckets.length; i++) {
          const a = q.sort.startsWith('hops') ? buckets[i].entry[0] : buckets[i].entry[0].slice(19);
          const b = q.sort.startsWith('hops') ? buckets[selected].entry[0] : buckets[selected].entry[0].slice(19);
          if (reverse ? a > b : a < b) selected = i;
        }
        const bucket = buckets[selected];
        const address = bucket.entry[0].slice(19);
        entries.push({ key: q.sort.startsWith('hops') ? bucket.entry[0] : `a:${address}`, address, degree: bucket.d });
        bucket.entry = await next(bucket.it);
        if (!bucket.entry) buckets.splice(selected, 1);
      }
      if (entries.length) {
        const records = await db.getMany(entries.map(e => `a:${e.address}`), { snapshot, fillCache: false });
        for (let i = 0; i < entries.length; i++) {
          if (!records[i] || records[i].d !== entries[i].degree) {
            throw new Error('Wallet hop index does not match its authoritative record');
          }
          entries[i].record = records[i];
        }
      }
    }
    const hasMore = entries.length > q.limit;
    if (hasMore) entries.pop();
    const wallets = entries.map(({ address, record }) => ({ address, hops: record.d, degree: record.d,
      isConnected: true, parent: record.p || null, origin: record.o || null, txHash: record.t || null, amount: record.n || 0 }));
    return { wallets, nextCursor: hasMore ? encodeWalletCursor(q, entries.at(-1).key) : null, hasMore, scanned };
  } finally {
    await Promise.all(iterators.map(it => it.close()));
    await snapshot.close();
  }
}

module.exports = { queryWallets, needsHopIndex };
