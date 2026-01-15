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
| `MAX_DEGREE` | Max transaction hops to track | `100` |
| `BATCH_SIZE` | Transactions per batch | `250` |
| `BATCH_FLUSH_INTERVAL` | Batch write interval (ms) | `5000` |

### Background Sync

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_ENABLED` | Enable background sync | `true` |
| `SYNC_INTERVAL` | Check interval when synced (ms) | `600000` |
| `CHUNK_SIZE` | Blocks per sync chunk | `100` |

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
