# Production Deployment

Guide for deploying TaintedBySatoshi in production using PM2.

## Prerequisites

- Node.js v18+
- PM2 installed globally: `npm install -g pm2`
- Bitcoin Core node running with `txindex=1`
- Configured `.env` files in both `backend/` and `frontend/`

## Quick Deploy

```bash
# From project root
npm run install:all
npm run build:frontend
npm run pm2:start
```

## PM2 Commands

### Basic Operations

| Command | Description |
|---------|-------------|
| `npm run pm2:start` | Start both services |
| `npm run pm2:stop` | Stop both services |
| `npm run pm2:restart` | Restart both services |
| `npm run pm2:delete` | Remove from PM2 |
| `npm run pm2:status` | View process status |
| `npm run pm2:monit` | Real-time monitoring |

### Individual Services

| Command | Description |
|---------|-------------|
| `npm run pm2:start:backend` | Start backend only |
| `npm run pm2:start:frontend` | Start frontend only |
| `npm run pm2:restart:backend` | Restart backend |
| `npm run pm2:restart:frontend` | Restart frontend (no rebuild) |
| `npm run pm2:reload:frontend` | Rebuild and restart frontend |

### Logs

| Command | Description |
|---------|-------------|
| `npm run pm2:logs` | All logs |
| `npm run pm2:logs:backend` | Backend logs |
| `npm run pm2:logs:frontend` | Frontend logs |

Or use PM2 directly:
```bash
pm2 logs TaintedBySatoshi_backend --lines 100
pm2 logs TaintedBySatoshi_frontend --lines 100
```

## Deployment Commands

| Command | Description |
|---------|-------------|
| `npm run deploy:frontend` | Rebuild + restart frontend |
| `npm run deploy:backend` | Restart backend |
| `npm run deploy:all` | Rebuild frontend + restart both |

## Background Synchronization

The backend automatically syncs new blocks in the background:

- **Very behind (>1000 blocks)**: Syncs every 5 seconds
- **Behind (>100 blocks)**: Syncs every 30 seconds
- **Almost synced (<100 blocks)**: Syncs every 2 minutes
- **Fully synced**: Checks every 10 minutes

Monitor sync progress:
```bash
curl http://localhost:3001/api/sync-status
```

## Updating Environment Variables

### Backend

Backend reads `.env` at runtime. Changes apply after restart:

```bash
nano backend/.env
npm run deploy:backend
```

### Frontend

**Important**: Frontend compiles `.env` at build time. You **must rebuild** after changes:

```bash
nano frontend/.env
npm run deploy:frontend  # Rebuilds and restarts
```

Simply restarting won't apply new frontend environment variables.

## PM2 Persistence

Save process list to survive reboots:

```bash
pm2 save
pm2 startup  # Generate startup script
```

## Memory Limits

Default configuration (`ecosystem.config.js`):
- Backend: 8GB max
- Frontend: 2GB max

Logs stored in:
- `backend/logs/`
- `frontend/logs/`

## Health Checks

```bash
# Backend health
curl http://localhost:3001/api/health

# Sync status
curl http://localhost:3001/api/sync-status

# Frontend (returns HTML)
curl http://localhost:3000
```

## Troubleshooting

### Backend won't start
- Check Bitcoin Core is running with RPC enabled
- Verify `backend/.env` has correct RPC credentials
- Check logs: `npm run pm2:logs:backend`

### Frontend shows old API URL
- Remember to rebuild after `.env` changes: `npm run deploy:frontend`

### High memory usage
- Backend caches transactions for performance
- Reduce `BITCOIN_CACHE_SIZE` in `backend/.env` if needed
- Memory is released after initial sync completes
