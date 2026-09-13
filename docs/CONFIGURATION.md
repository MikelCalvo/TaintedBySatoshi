# 🫟 Configuration Reference

All environment variables for TaintedBySatoshi.

## Backend Variables

Create `backend/.env` with these variables:

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3001` |
| `NODE_ENV` | Environment mode | `development` |
| `FRONTEND_URL` | Frontend URL for CORS | - |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |

### Bitcoin Core RPC

| Variable | Description | Default |
|----------|-------------|---------|
| `BITCOIN_RPC_HOST` | Node hostname | `localhost` |
| `BITCOIN_RPC_PORT` | RPC port | `8332` |
| `BITCOIN_RPC_USER` | RPC username | *required* |
| `BITCOIN_RPC_PASS` | RPC password | *required* |
| `BITCOIN_RPC_TIMEOUT` | Request timeout (ms) | `60000` |

### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_PATH` | Main database path | `./data/satoshi-transactions` |

### Processing

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_DEGREE` | Max hop distance to persist (`0` = unlimited) | `0` |
| `BATCH_SIZE` | Transactions per batch | `250` |
| `BATCH_FLUSH_INTERVAL` | Batch write interval (ms) | `5000` |

### Background Sync

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_ENABLED` | Enable background sync | `true` |
| `SYNC_INTERVAL` | Check interval when synced (ms) | `600000` |
| `CHUNK_SIZE` | Blocks per sync chunk (clamped to 1-500) | `100` |
| `SYNC_PREFETCH_CONCURRENCY` | Concurrent RPC block fetches (clamped to 1-32) | `8` |
| `LEVELDB_CACHE_MB` | LevelDB uncompressed read cache in MiB (clamped to 16-512) | `128` |
| `LEVELDB_BLOCK_KB` | LevelDB SST table block size in KiB (strict integer; accepted 4-64, default 32; valid out-of-range values clamp, non-integers/text fall back to 32) | `32` |
| `LIVE_UTXO_CACHE_SIZE` | Hot live-taint UTXOs held in bounded LRU memory (clamped to 1-1,000,000) | `250000` |
| `ADDRESS_CACHE_SIZE` | Hot compact wallet hop records held in bounded LRU memory (clamped to 1-1,000,000) | `250000` |

The LevelDB cache is especially relevant when the database lives on NAS/CIFS.
It reduces repeated remote table-block reads without moving persistent data off
the NAS. Increase it only when the host has measured memory headroom.

`LEVELDB_BLOCK_KB` only affects newly written SST table files. Existing 4 KiB
blocks stay readable; schema version 4 is unchanged; write buffer, max file
size, and cache size are not altered. There is no forced `compactRange` or
database rebuild. Rollback is `LEVELDB_BLOCK_KB=4` and a backend restart, with no
data or schema reset.

`/api/sync-status` reports `storage.levelDbBlockKb`. The pipeline window's
`prefetchMs` measures the RPC fetch itself, excluding time a completed
prefetch sits waiting for the previous window. `prefetchWaitMs` measures only
the outstanding RPC wait when the next window consumes that prefetch.

This is **not** a measured production catch-up gain. An isolated synthetic
benchmark on the same NAS production path (not the active database), 12k
fixture wallet/UTXO records per trial, compared default 4 KiB blocks vs 32 KiB:

| Trial | 4 KiB | 32 KiB |
|-------|-------|--------|
| Flush (ms) | 49555 / 47865 | 28900 / 21681 |
| Batch write (ms) | 14707 / 15019 | 18894 / 19081 |
| Cold 100 reads (ms) | 248 / 246 | 130 / 277 |
| SST bytes | 1651049 | 1539513 |

Flush was faster at 32 KiB; batched writes were slower; cold random reads were
mixed (130 ms vs 277 ms on the second 32 KiB trial). Larger blocks can hurt
random-read latency because each lookup reads a bigger uncompressed block.
Treat 32 KiB as a bounded local-NAS default, not a guaranteed production
speedup.

### Bitcoin Performance Tuning

| Variable | Description | Default |
|----------|-------------|---------|
| `BITCOIN_BATCH_SIZE` | RPC batch size | `100` |
| `BITCOIN_BLOCK_BATCH_SIZE` | Blocks per batch | `10` |
| `BITCOIN_MAX_PARALLEL` | Parallel RPC requests | `16` |
| `BITCOIN_CACHE_SIZE` | Transactions in memory | `10000` |
| `BITCOIN_RETRY_DELAY` | Retry delay (ms) | `500` |
| `BITCOIN_MAX_RETRIES` | Max retry attempts | `5` |
| `BITCOIN_MEMORY_THRESHOLD` | GC threshold (0-1) | `0.85` |
| `BITCOIN_BLOCK_TIMEOUT` | Block fetch timeout (ms) | `300000` |

### Analytics

| Variable | Description | Default |
|----------|-------------|---------|
| `ANALYTICS_ENABLED` | Enable analytics | `true` |
| `ANALYTICS_DB_PATH` | Analytics database path | `./data/analytics` |
| `ANALYTICS_BATCH_SIZE` | Events before flush | `100` |
| `ANALYTICS_FLUSH_INTERVAL` | Flush interval (ms) | `10000` |
| `ANALYTICS_RETENTION_DAYS` | Data retention (0=infinite) | `0` |

## Frontend Variables

Create `frontend/.env` with these variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API URL | `http://localhost:3001` |
| `NEXT_PUBLIC_SITE_URL` | Public site URL (for SEO) | `https://taintedbysatoshi.com` |
| `NEXT_PUBLIC_DONATION_ADDRESS` | Bitcoin donation address | - |
| `NEXT_PUBLIC_LIGHTNING_ADDRESS` | Lightning address for donations | - |
| `NEXT_PUBLIC_REPOSITORY_URL` | GitHub repository URL | - |

**Note**: Frontend variables are compiled at build time. After changing `frontend/.env`, you must rebuild:

```bash
npm run deploy:frontend
```

## Quick Setup

Copy the example files and edit with your values:

```bash
# Backend
cp backend/.env.example backend/.env
nano backend/.env

# Frontend
cp frontend/.env.example frontend/.env
nano frontend/.env
```

## Bitcoin Core Configuration

Add to `bitcoin.conf` for optimal performance:

```conf
# Required
txindex=1

# RPC
server=1
rpcuser=myuser
rpcpassword=mypassword
rpcworkqueue=128
rpcthreads=8
rpctimeout=60

# Performance
dbcache=4096
par=8
```
