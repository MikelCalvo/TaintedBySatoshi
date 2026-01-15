# 🫟 Tainted By Satoshi

Web application to check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets through transaction history.

## Features

- Check direct and indirect connections to Satoshi's ~22,000 known addresses
- Track transaction paths showing how Bitcoin flowed from Satoshi
- Uses verified Patoshi pattern analysis (21,953 blocks)
- Privacy-respecting analytics (no cookies, anonymous data)
- Background blockchain synchronization

## Quick Start

### Prerequisites

- Node.js v18+
- Bitcoin Core v22+ with `txindex=1` enabled
- 10GB+ free disk space

### Installation

```bash
git clone https://github.com/MikelCalvo/TaintedBySatoshi.git
cd TaintedBySatoshi

# Install dependencies
cd backend && npm install
cd ../frontend && npm install
```

### Configuration

**Backend** (`backend/.env`):
```env
PORT=3001
BITCOIN_RPC_HOST=localhost
BITCOIN_RPC_PORT=8332
BITCOIN_RPC_USER=your_username
BITCOIN_RPC_PASS=your_password
DB_PATH=./data/satoshi-transactions
```

**Frontend** (`frontend/.env`):
```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Run Development

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

Access at http://localhost:3000

### Initialize Database

First run requires building the taint database:

```bash
cd backend
npm run update-satoshi-data
```

This extracts ~22,000 Satoshi addresses and scans the blockchain for connections (takes several hours).

## Production

Use PM2 for production deployment:

```bash
# From root directory
npm run install:all
npm run build:frontend
npm run pm2:start
```

The backend auto-syncs new blocks in the background.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full production setup.

## API

### `GET /api/check/:address`

Check if an address is connected to Satoshi.

**Response:**
```json
{
  "isConnected": true,
  "isSatoshiAddress": false,
  "degree": 3,
  "connectionPath": [
    {"from": "1A1z...", "to": "1BvB...", "txHash": "abc123...", "amount": 50}
  ]
}
```

### Other Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/sync-status` | Blockchain sync progress |
| `GET /api/health` | Health check |
| `GET /api/analytics/stats` | Public usage statistics |

## Documentation

- [Development Guide](docs/DEVELOPMENT.md) - Scripts, debugging, local setup
- [Deployment Guide](docs/DEPLOYMENT.md) - PM2, production, monitoring
- [Configuration Reference](docs/CONFIGURATION.md) - All environment variables
- [Patoshi Analysis](docs/PATOSHI.md) - Technical background on Satoshi identification

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 14, Material-UI, React |
| Backend | Express.js, LevelDB |
| Bitcoin | bitcoinjs-lib, Bitcoin Core RPC |
| Process Manager | PM2 |

## Notes

- Only tracks **outgoing** transactions from Satoshi to avoid false positives
- Supports all address types (P2PKH, P2SH, SegWit)
- Initial sync takes several hours depending on hardware

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes
4. Push and open PR

## License

[ISC](LICENSE.md)
