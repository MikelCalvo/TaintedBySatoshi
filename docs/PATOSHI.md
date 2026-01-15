# Patoshi Pattern Analysis

Technical background on how TaintedBySatoshi identifies Satoshi Nakamoto's addresses.

## What is Patoshi?

"Patoshi" refers to a unique mining pattern discovered by **Sergio Demian Lerner** in 2013 that identifies blocks mined by Satoshi Nakamoto with high confidence.

The name comes from combining "Pattern" + "Satoshi".

## Identifying Patterns

Satoshi's mining software had distinctive characteristics that differentiate his blocks from other early miners:

### 1. Nonce LSB Pattern

The last byte of the block nonce falls within specific ranges:
- **Satoshi**: 0-9 or 19-58
- **Other miners**: 10-18 or 59-255

This pattern is visible when plotting nonce values across early blocks.

### 2. ExtraNonce Increment Rate

Satoshi's miner incremented the extraNonce ~5x faster than normal, only scanning approximately 1/5 of the nonce space before moving to the next extraNonce value.

### 3. Timestamp Behavior

Satoshi's blocks never exhibit backwards timestamp adjustments, unlike many other early miners who would sometimes set timestamps in the past.

## Dataset

TaintedBySatoshi uses verified Patoshi data:

| Source | Count | Description |
|--------|-------|-------------|
| Genesis block | 1 | Block 0 |
| Early blocks | 2 | Blocks 1-2 |
| Patoshi blocks | 21,953 | Blocks 3-49,973 |
| **Total** | **~21,956** | Unique addresses |

### Data Sources

- **Patoshi block list**: Curated by Sergio Demian Lerner & Jameson Lopp
- **Repository**: https://github.com/bensig/patoshi-addresses
- **Original research**: https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/

## Address Extraction

When you run `npm run update-satoshi-data`, the application:

1. Reads the list of 21,953 verified Patoshi block heights from `backend/src/data/patoshiBlocks.js`
2. Queries Bitcoin Core for each block
3. Extracts the coinbase transaction output address
4. Saves addresses to `backend/data/satoshiAddresses.js`

This process takes ~25-30 minutes on first run and is skipped on subsequent runs.

## Taint Analysis

After extracting Satoshi's addresses, the application performs taint analysis:

1. **Degree 0**: Satoshi's original addresses (~22,000)
2. **Degree 1**: Addresses that received Bitcoin directly from Satoshi
3. **Degree 2**: Addresses that received from Degree 1 addresses
4. **Degree N**: Continues up to `MAX_DEGREE` (default: 100)

### Why Outgoing Only?

The application only tracks **outgoing** transactions from Satoshi addresses. This prevents false positives from:

- Users sending small amounts to known Satoshi addresses
- Dust attacks targeting famous addresses
- Accidental sends to Satoshi's genesis address

## Estimated Holdings

Based on Patoshi pattern analysis, Satoshi is estimated to have mined:

- **~1.1 million BTC** across 22,000 blocks
- Block rewards were 50 BTC each in 2009
- Nearly all remain unspent to this day

## Research References

1. Lerner, S.D. (2013). "The Well Deserved Fortune of Satoshi Nakamoto"
   - https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/

2. Lerner, S.D. (2019). "The Patoshi Mining Machine"
   - https://bitslog.com/2019/04/16/the-return-of-the-deniers-and-the-revenge-of-patoshi/

3. Lopp, J. "Patoshi Blocks Research"
   - https://github.com/bensig/patoshi-addresses

## Limitations

- Pattern analysis provides high confidence but not absolute certainty
- Some early blocks may be misattributed in either direction
- Address reuse was common in 2009, affecting some calculations
- The genesis block coinbase is unspendable by design
