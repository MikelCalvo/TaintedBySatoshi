function outpointKey(txid, vout) {
  return `${txid}:${vout}`;
}

function compactRecord({ degree, address, parent, txHash, amount, origin }) {
  return {
    d: degree,
    a: address || null,
    p: parent || null,
    t: txHash,
    n: amount,
    o: origin || null,
  };
}

function addressRecord(record) {
  return {
    d: record.d,
    p: record.p,
    t: record.t,
    n: record.n,
    o: record.o,
  };
}

function mergeAddressRecord(existing, candidate) {
  if (!candidate || !Number.isInteger(candidate.d) || candidate.d < 0) {
    return null;
  }
  if (!existing || existing.d > candidate.d) {
    return {
      d: candidate.d,
      p: candidate.p || null,
      t: candidate.t,
      n: candidate.n,
      o: candidate.o || null,
    };
  }
  return null;
}

function netMutations(mutations) {
  const created = mutations?.created || [];
  const spent = mutations?.spent || [];
  const spentSet = new Set(spent);
  const createdOutpoints = new Set(created.map((entry) => entry.outpoint));
  return {
    created: created.filter((entry) => !spentSet.has(entry.outpoint)),
    spent: spent.filter((outpoint) => !createdOutpoints.has(outpoint)),
    addresses: mutations?.addresses || [],
  };
}

function processBlockTaint(block, options = {}) {
  const isSeedAddress = options.isSeedAddress || (() => false);
  const getOutpoint = options.getOutpoint || (() => undefined);
  const maxDegree = Number.isInteger(options.maxDegree) ? options.maxDegree : 0;

  const created = [];
  const spent = [];
  const addresses = [];
  const seenSpent = new Set();
  const live = new Map();
  const addressSeen = new Map();

  function rememberAddress(address, record) {
    if (!address) return;
    const candidate = addressRecord(record);
    const existing = addressSeen.get(address);
    const merged = mergeAddressRecord(existing, candidate);
    if (!merged) return;
    addressSeen.set(address, merged);
  }

  function lookup(outpoint) {
    if (live.has(outpoint)) return live.get(outpoint);
    return getOutpoint(outpoint);
  }

  for (const tx of block.tx || []) {
    const txid = tx.txid || tx.hash;
    const inputRecords = [];
    let minDegree = Infinity;
    let parent = null;
    let origin = null;

    for (const vin of tx.vin || []) {
      if (vin.coinbase) continue;
      const spentOutpoint = outpointKey(vin.txid, vin.vout);
      const tainted = lookup(spentOutpoint);
      if (!tainted) continue;
      if (!seenSpent.has(spentOutpoint)) {
        seenSpent.add(spentOutpoint);
        spent.push(spentOutpoint);
        live.delete(spentOutpoint);
      }
      inputRecords.push(tainted);
      if (tainted.d < minDegree) {
        minDegree = tainted.d;
        parent = tainted.a || null;
        origin = tainted.o || tainted.a || null;
      }
    }

    const outputs = (tx.vout || []).map((vout, index) => ({
      index,
      address: vout.scriptPubKey?.address || null,
      value: vout.value,
    }));

    const seedOutputs = outputs.filter(
      (output) => output.address && isSeedAddress(output.address)
    );
    const taintedByInput = Number.isFinite(minDegree);
    if (!taintedByInput && seedOutputs.length === 0) continue;

    if (taintedByInput) {
      const nextDegree = minDegree + 1;
      const hopAllowed = maxDegree <= 0 || nextDegree <= maxDegree;
      if (hopAllowed) {
        for (const output of outputs) {
          const record = compactRecord({
            degree: nextDegree,
            address: output.address,
            parent,
            txHash: txid,
            amount: output.value,
            origin,
          });
          const createdOutpoint = outpointKey(txid, output.index);
          live.set(createdOutpoint, record);
          created.push({ outpoint: createdOutpoint, record });
          rememberAddress(output.address, record);
        }
      }
    } else {
      for (const output of seedOutputs) {
        const record = compactRecord({
          degree: 0,
          address: output.address,
          parent: null,
          txHash: txid,
          amount: output.value,
          origin: output.address,
        });
        const createdOutpoint = outpointKey(txid, output.index);
        live.set(createdOutpoint, record);
        created.push({ outpoint: createdOutpoint, record });
        rememberAddress(output.address, record);
      }
    }
  }

  for (const [address, record] of addressSeen) {
    addresses.push({ address, record });
  }

  return { created, spent, addresses };
}

class TaintStore {
  constructor() {
    this.outpoints = new Map();
    this.addresses = new Map();
  }

  get liveOutpoints() {
    return this.outpoints.size;
  }

  get taintedWallets() {
    return this.addresses.size;
  }

  getOutpoint(outpoint) {
    return this.outpoints.get(outpoint);
  }

  getAddress(address) {
    return this.addresses.get(address);
  }

  putOutpoint(outpoint, record) {
    this.outpoints.set(outpoint, record);
  }

  putAddress(address, record) {
    this.addresses.set(address, record);
  }

  applyMutations(mutations) {
    const operations = [];
    for (const outpoint of mutations.spent || []) {
      if (this.outpoints.delete(outpoint)) {
        operations.push({ type: "del", key: `u:${outpoint}` });
      }
    }
    for (const { outpoint, record } of mutations.created || []) {
      this.outpoints.set(outpoint, record);
      operations.push({ type: "put", key: `u:${outpoint}`, value: record });
    }
    for (const { address, record } of mutations.addresses || []) {
      const merged = mergeAddressRecord(this.addresses.get(address), record);
      if (!merged) continue;
      this.addresses.set(address, merged);
      operations.push({ type: "put", key: `a:${address}`, value: merged });
    }
    return operations;
  }

  async loadFrom(db) {
    for await (const [key, value] of db.iterator()) {
      if (key.startsWith("u:")) {
        this.outpoints.set(key.slice(2), value);
      } else if (key.startsWith("a:")) {
        this.addresses.set(key.slice(2), value);
      }
    }
  }
}

module.exports = {
  processBlockTaint,
  mergeAddressRecord,
  compactRecord,
  netMutations,
  TaintStore,
};
