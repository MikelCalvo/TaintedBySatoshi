# Development Guide

Local development setup and available scripts.

## Prerequisites

- Node.js v18+
- Bitcoin Core v22+ running with:
  - `server=1`
  - `txindex=1`
  - RPC credentials configured

## Setup

```bash
git clone https://github.com/MikelCalvo/TaintedBySatoshi.git
cd TaintedBySatoshi

# Backend
cd backend
npm install
cp .env.example .env  # Edit with your Bitcoin RPC credentials

# Frontend
cd ../frontend
npm install
cp .env.example .env  # Edit API URL if needed
```

## Running Locally

```bash
# Terminal 1: Backend (port 3001)
cd backend
npm run dev

# Terminal 2: Frontend (port 3000)
cd frontend
npm run dev
```

## Backend Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Production server |
| `npm run dev` | Development with hot reload |
| `npm run check-node` | Test Bitcoin RPC connection |
| `npm run update-satoshi-data` | Build/update taint database |
| `npm run check-satoshi-data` | Show database statistics |

### Database Initialization

First run requires building the taint database:

```bash
cd backend
npm run update-satoshi-data
```

This script:
1. Extracts ~22,000 addresses from Patoshi blocks (first run: ~25-30 min)
2. Scans blockchain for all tainted transactions (several hours)
3. Builds connection paths in LevelDB

Subsequent runs skip address extraction and continue from last block.

### Checking Node Connection

```bash
cd backend
npm run check-node
```

Verifies Bitcoin Core RPC is accessible and returns node info.

### Database Statistics

```bash
cd backend
npm run check-satoshi-data
```

Shows:
- Number of Satoshi addresses
- Total tainted addresses tracked
- Last processed block

## Frontend Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Production server |
| `npm run lint` | Run ESLint |

## Project Structure

```
TaintedBySatoshi/
├── backend/
│   ├── src/
│   │   ├── index.js              # Express server
│   │   ├── services/
│   │   │   ├── bitcoinRPC.js     # Bitcoin Core client
│   │   │   ├── bitcoinService.js # Address verification
│   │   │   ├── dbService.js      # LevelDB operations
│   │   │   ├── backgroundSyncService.js
│   │   │   └── analyticsService.js
│   │   ├── scripts/
│   │   │   ├── updateSatoshiData.js
│   │   │   ├── extractPatoshiAddresses.js
│   │   │   └── checkNodeStatus.js
│   │   └── data/
│   │       └── patoshiBlocks.js  # 21,953 verified blocks
│   └── data/                     # LevelDB databases
│       ├── satoshi-transactions/
│       └── analytics/
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── index.js          # Search page
│       │   ├── address/[addr].js # Results page
│       │   ├── status.js         # Sync status
│       │   └── stats.js          # Analytics
│       ├── components/
│       └── config/
│
├── docs/                         # Documentation
├── ecosystem.config.js           # PM2 config
└── package.json                  # Root scripts
```

## API Endpoints

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/check/:address` | GET | Check address connection |
| `/api/sync-status` | GET | Sync progress |
| `/api/health` | GET | Health check |

### Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/track` | POST | Track event |
| `/api/analytics/stats` | GET | Public statistics |
| `/api/analytics/status` | GET | Analytics status |

## Debugging

### Backend Logs

Development mode logs to console. Check for:
- RPC connection errors
- Database operations
- Sync progress

### Memory Issues

The update script uses Node.js flags for large datasets:
```bash
node --expose-gc --max-old-space-size=8192 src/scripts/updateSatoshiData.js
```

If you run out of memory, reduce `BITCOIN_CACHE_SIZE` in `.env`.

### Common Issues

**RPC Connection Failed**
- Verify Bitcoin Core is running
- Check RPC credentials in `.env`
- Ensure `server=1` in bitcoin.conf

**Address Not Found**
- Database may not be initialized
- Run `npm run update-satoshi-data`

**Slow Queries**
- Initial sync in progress
- Check sync status: `curl localhost:3001/api/sync-status`
