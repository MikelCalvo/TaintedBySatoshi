const { encodeWalletCursor } = require('../utils/validation');

const MAX_READS = 2000;
const PREFIX_PROBE_LIMIT = 32;
const SMALL_HOP_RANGE = 32;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const degreePrefix = d => `h:${String(d).padStart(16, '0')}:`;
const hopBoundary = d => degreePrefix(d);
const upperPrefix = p => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const needsHopIndex = q => q.sort.startsWith('hops') || q.minHops != null || q.maxHops != null;
const isHopBoundary = key => typeof key === 'string' && /^h:\d{16}:$/.test(key);

function nextDegree(d) {
  return d >= MAX_SAFE ? null : d + 1;
}

function prevDegree(d) {
  return d <= 0 ? null : d - 1;
}

function parseHopKey(key) {
  return { degree: Number(key.slice(2, 18)), address: key.slice(19) };
}

function inHopRange(degree, min, max) {
  return degree >= min && degree <= max;
}

function compareHop(a, b, reverse) {
  if (a.degree !== b.degree) return reverse ? b.degree - a.degree : a.degree - b.degree;
  if (a.address < b.address) return reverse ? 1 : -1;
  if (a.address > b.address) return reverse ? -1 : 1;
  return 0;
}

function afterHopCursor(record, cursor, reverse) {
  if (!cursor) return true;
  const { degree, address } = parseHopKey(cursor);
  if (address === '') return reverse ? record.degree < degree : record.degree > degree;
  return compareHop(record, { degree, address }, reverse) > 0;
}

async function queryWallets(db, q) {
  const snapshot = db.snapshot();
  const iterators = [];
  let scanned = 0;
  let limited = false;
  let exhausted = false;
  let progressKey = null;
  const reverse = q.sort.endsWith('desc');
  const target = q.limit + 1;
  const min = q.minHops ?? 0;
  const max = q.maxHops ?? MAX_SAFE;
  const prefix = q.q || '';
  const entries = [];

  function iterator(options) {
    const it = db.iterator({ ...options, snapshot, fillCache: false, highWaterMarkBytes: 32768 });
    iterators.push(it);
    return it;
  }

  async function next(it) {
    if (scanned >= MAX_READS) {
      limited = true;
      return undefined;
    }
    scanned += 1;
    return it.next();
  }

  async function release(it) {
    try {
      await it.close();
    } catch {
      // finally still closes any remaining iterators
    }
  }

  function tighterLt(current, candidate) {
    return current == null || candidate < current ? candidate : current;
  }

  function tighterGte(current, candidate) {
    return current == null || candidate > current ? candidate : current;
  }

  async function hydrate(page) {
    if (!page.length || page.every(entry => entry.record)) return;
    const records = await db.getMany(page.map(entry => `a:${entry.address}`), { snapshot, fillCache: false });
    for (let i = 0; i < page.length; i += 1) {
      if (!records[i] || records[i].d !== page[i].degree) {
        throw new Error('Wallet hop index does not match its authoritative record');
      }
      page[i].record = records[i];
    }
  }

  async function scanAddressKeys({ hopFilter }) {
    const rangePrefix = `a:${prefix}`;
    const options = { gte: rangePrefix, lt: upperPrefix(rangePrefix), reverse };
    if (!hopFilter) options.limit = target;
    if (q.cursor) {
      if (reverse) options.lt = q.cursor;
      else {
        delete options.gte;
        options.gt = q.cursor;
      }
    }
    const it = iterator(options);
    try {
      while (entries.length < target) {
        const entry = await next(it);
        if (!entry) {
          if (!limited) exhausted = true;
          break;
        }
        progressKey = entry[0];
        const address = entry[0].slice(2);
        const record = entry[1];
        if (hopFilter && !inHopRange(record.d, min, max)) continue;
        entries.push({ key: entry[0], address, record, degree: record.d });
      }
    } finally {
      await release(it);
    }
  }

  async function scanHopRange() {
    const options = {
      gte: degreePrefix(min),
      lt: upperPrefix(degreePrefix(max)),
      reverse,
      limit: target,
    };
    if (q.cursor) {
      const { degree, address } = parseHopKey(q.cursor);
      if (address === '') {
        if (reverse) options.lt = tighterLt(options.lt, degreePrefix(degree));
        else {
          const n = nextDegree(degree);
          if (n == null || n > max) {
            exhausted = true;
            return;
          }
          options.gte = tighterGte(options.gte, degreePrefix(n));
        }
      } else if (reverse) {
        options.lt = q.cursor;
      } else {
        delete options.gte;
        options.gt = q.cursor;
      }
    }
    const it = iterator(options);
    try {
      while (entries.length < target) {
        const entry = await next(it);
        if (!entry) {
          if (!limited) exhausted = true;
          break;
        }
        const parsed = parseHopKey(entry[0]);
        if (!Number.isSafeInteger(parsed.degree) || !inHopRange(parsed.degree, min, max)) {
          if (!limited) exhausted = true;
          break;
        }
        progressKey = entry[0];
        entries.push({ key: entry[0], address: parsed.address, degree: parsed.degree });
      }
    } finally {
      await release(it);
    }
  }

  async function probePrefix() {
    const rangePrefix = `a:${prefix}`;
    const it = iterator({ gte: rangePrefix, lt: upperPrefix(rangePrefix) });
    const records = [];
    let seen = 0;
    try {
      while (seen < PREFIX_PROBE_LIMIT) {
        const entry = await next(it);
        if (!entry) return { exhausted: !limited, records };
        seen += 1;
        const address = entry[0].slice(2);
        const record = entry[1];
        if (inHopRange(record.d, min, max)) records.push({ address, record, degree: record.d });
      }
      return { exhausted: false, records };
    } finally {
      await release(it);
    }
  }

  function paginateProbed(records) {
    records.sort((a, b) => compareHop(a, b, reverse));
    for (const record of records) {
      if (!afterHopCursor(record, q.cursor, reverse)) continue;
      if (entries.length >= target) break;
      entries.push({
        key: `${degreePrefix(record.degree)}${record.address}`,
        address: record.address,
        degree: record.degree,
        record: record.record,
      });
    }
    if (entries.length < target) exhausted = true;
  }

  async function prefixExistsAt(degree) {
    const bucket = degreePrefix(degree) + prefix;
    const probe = iterator({ gte: bucket, lt: upperPrefix(bucket), reverse, limit: 1 });
    const hit = await next(probe);
    await release(probe);
    return Boolean(hit);
  }

  async function findNextPrefixDegree(after) {
    let start = nextDegree(after);
    while (start != null && start <= max && !limited) {
      const it = iterator({
        gte: degreePrefix(start) + prefix,
        lt: upperPrefix(degreePrefix(max)),
        limit: 1,
      });
      const entry = await next(it);
      await release(it);
      if (!entry) return null;
      const hit = parseHopKey(entry[0]);
      if (!Number.isSafeInteger(hit.degree) || hit.degree > max) return null;
      if (await prefixExistsAt(hit.degree)) return hit.degree;
      if (limited) return null;
      progressKey = hopBoundary(hit.degree);
      start = nextDegree(hit.degree);
    }
    return null;
  }

  async function findPrevPrefixDegree(before) {
    let start = prevDegree(before);
    while (start != null && start >= min && !limited) {
      const bucket = degreePrefix(start) + prefix;
      const probe = iterator({ gte: bucket, lt: upperPrefix(bucket), reverse: true, limit: 1 });
      const hit = await next(probe);
      await release(probe);
      if (hit) return start;
      if (limited) return null;
      progressKey = hopBoundary(start);
      const disc = iterator({
        gte: degreePrefix(min),
        lt: degreePrefix(start),
        reverse: true,
        limit: 1,
      });
      const prev = await next(disc);
      await release(disc);
      if (!prev) return null;
      const parsed = parseHopKey(prev[0]);
      if (!Number.isSafeInteger(parsed.degree) || parsed.degree < min) return null;
      start = parsed.degree;
    }
    return null;
  }

  async function scanHopPrefixLazy() {
    let degree;
    let addressCursor = null;
    if (q.cursor) {
      const parsed = parseHopKey(q.cursor);
      if (parsed.address === '') {
        degree = reverse ? prevDegree(parsed.degree) : nextDegree(parsed.degree);
      } else {
        degree = parsed.degree;
        addressCursor = parsed.address;
      }
    } else {
      degree = reverse ? max : min;
    }

    while (degree != null && degree >= min && degree <= max && entries.length < target && !limited) {
      const bucket = degreePrefix(degree) + prefix;
      const options = { gte: bucket, lt: upperPrefix(bucket), reverse };
      if (addressCursor) {
        const cursorKey = degreePrefix(degree) + addressCursor;
        if (reverse) options.lt = cursorKey;
        else {
          delete options.gte;
          options.gt = cursorKey;
        }
      }
      const it = iterator(options);
      try {
        while (entries.length < target) {
          const entry = await next(it);
          if (!entry) break;
          const parsed = parseHopKey(entry[0]);
          progressKey = entry[0];
          entries.push({ key: entry[0], address: parsed.address, degree });
        }
      } finally {
        await release(it);
      }
      if (entries.length >= target) break;
      if (limited) {
        if (!progressKey) progressKey = hopBoundary(degree);
        break;
      }
      progressKey = hopBoundary(degree);
      addressCursor = null;
      degree = reverse ? await findPrevPrefixDegree(degree) : await findNextPrefixDegree(degree);
    }

    if (!limited && (degree == null || degree < min || degree > max) && entries.length < target) {
      exhausted = true;
    }
  }

  async function mergeAddressBuckets() {
    const buckets = [];
    for (let degree = min; degree <= max; degree += 1) {
      const bucket = degreePrefix(degree) + prefix;
      const options = { gte: bucket, lt: upperPrefix(bucket), reverse };
      if (q.cursor) {
        const mapped = degreePrefix(degree) + q.cursor.slice(2);
        if (reverse) options.lt = mapped;
        else {
          delete options.gte;
          options.gt = mapped;
        }
      }
      const it = iterator(options);
      const first = await next(it);
      if (first) buckets.push({ it, entry: first, d: degree });
      else await release(it);
      if (limited) break;
    }

    while (buckets.length && entries.length < target && !limited) {
      let selected = 0;
      for (let i = 1; i < buckets.length; i += 1) {
        const a = buckets[i].entry[0].slice(19);
        const b = buckets[selected].entry[0].slice(19);
        if (reverse ? a > b : a < b) selected = i;
      }
      const bucket = buckets[selected];
      const address = bucket.entry[0].slice(19);
      const key = `a:${address}`;
      progressKey = key;
      entries.push({ key, address, degree: bucket.d });
      bucket.entry = await next(bucket.it);
      if (!bucket.entry) {
        await release(bucket.it);
        buckets.splice(selected, 1);
      }
    }
    await Promise.all(buckets.map(bucket => release(bucket.it)));
    if (!limited && !buckets.length && entries.length < target) exhausted = true;
  }

  try {
    if (!needsHopIndex(q)) {
      await scanAddressKeys({ hopFilter: false });
    } else if (q.sort.startsWith('hops')) {
      if (!prefix) {
        await scanHopRange();
      } else {
        const probed = await probePrefix();
        if (probed.exhausted) paginateProbed(probed.records);
        else await scanHopPrefixLazy();
      }
    } else if ((max - min) < SMALL_HOP_RANGE) {
      await mergeAddressBuckets();
    } else {
      await scanAddressKeys({ hopFilter: true });
    }

    const extra = entries.length > q.limit;
    if (extra) entries.pop();
    const scanLimited = Boolean(limited && !extra && !exhausted);
    const hasMore = extra || scanLimited;
    await hydrate(entries);

    let nextCursor = null;
    if (extra) {
      nextCursor = encodeWalletCursor(q, entries.at(-1).key);
    } else if (scanLimited) {
      const key = progressKey || entries.at(-1)?.key;
      if (key) {
        nextCursor = encodeWalletCursor(q, key, { version: isHopBoundary(key) ? 2 : 1 });
      }
    }

    const wallets = entries.map(({ address, record }) => ({
      address,
      hops: record.d,
      degree: record.d,
      isConnected: true,
      parent: record.p || null,
      origin: record.o || null,
      txHash: record.t || null,
      amount: record.n || 0,
    }));
    return {
      wallets,
      nextCursor,
      hasMore,
      scanned,
      ...(scanLimited ? { scanLimited: true } : {}),
    };
  } finally {
    await Promise.allSettled(iterators.map(it => it.close()));
    try {
      await snapshot.close();
    } catch {
      // iterator cleanup must not leave the snapshot open
    }
  }
}

module.exports = { queryWallets, needsHopIndex };
