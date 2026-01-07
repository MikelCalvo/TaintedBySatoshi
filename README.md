# 🌟 Tainted By Satoshi

A web application that allows you to check if a Bitcoin address has any connection to Satoshi Nakamoto's known wallet addresses through transaction history. The application tracks both direct connections (addresses that received Bitcoin directly from Satoshi) and indirect connections through any number of transaction hops.

## 🚀 Features

- Search any Bitcoin address
- Check direct and indirect connections to Satoshi's wallets
- Track transaction paths from Satoshi to target address
- View detailed transaction information
- Server-side rendered pages for better SEO and caching
- Clean, responsive Material UI design
- Real-time Bitcoin node integration

## 🏗️ Tech Stack

### Frontend

- **Framework**: Next.js 14
- **UI Library**: Material-UI (MUI)
- **State Management**: React Hooks
- **HTTP Client**: Axios
- **Bitcoin Tools**: bitcoinjs-lib

### Backend

- **Runtime**: Node.js
- **Framework**: Express
- **Database**: LevelDB for caching and transaction data
- **Bitcoin Integration**: Direct Bitcoin Core RPC
- **Validation**: bitcoinjs-lib

## 🛠️ Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Bitcoin Core node (v22.0 or higher)
- At least 10GB of free disk space for the database

## 📦 Installation

1. Clone the repository:

```bash
git clone https://github.com/MikelCalvo/TaintedBySatoshi.git
cd TaintedBySatoshi
```

2. Install backend dependencies:

```bash
cd backend
npm install
```

3. Install frontend dependencies:

```bash
cd ../frontend
npm install
```

4. Configure environment variables:

Backend `.env`:

```env
# Server Configuration
PORT=3001
NODE_ENV=development

# Bitcoin Node Configuration
BITCOIN_RPC_HOST=localhost
BITCOIN_RPC_PORT=8332
BITCOIN_RPC_USER=your_rpc_username
BITCOIN_RPC_PASS=your_rpc_password
BITCOIN_RPC_TIMEOUT=30000

# Database Configuration
DB_PATH=./data/satoshi-transactions

# Processing Configuration
MAX_DEGREE=100                    # Maximum tinting degree to process
BATCH_SIZE=250                   # Number of transactions to process in parallel
CACHE_TTL=3600                   # Cache time-to-live in seconds
UPDATE_INTERVAL=3600             # How often to update the database in seconds

# Performance Tuning
BITCOIN_BATCH_SIZE=250           # Number of blocks to process in one batch
BITCOIN_MAX_PARALLEL=32          # Number of parallel RPC requests
BITCOIN_CACHE_SIZE=50000         # Number of transactions to keep in memory
BITCOIN_RETRY_DELAY=500          # Milliseconds to wait between retries
BITCOIN_MAX_RETRIES=5            # Number of times to retry failed requests
BITCOIN_MEMORY_THRESHOLD=0.90    # Memory usage threshold for GC
```

Frontend `.env`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## 🚀 Running the Application

1. Start Bitcoin Core with RPC and txindex enabled:

```bash
bitcoind -server -rpcuser=your_username -rpcpassword=your_password -txindex=1
```

2. Start the backend server:

```bash
cd backend
npm run dev
```

3. Start the frontend development server:

```bash
cd frontend
npm run dev
```

4. Initialize the Satoshi transaction database:

```bash
cd backend
npm run update-satoshi-data
```

**Note:** The `update-satoshi-data` script automatically handles everything:
- Extracts Patoshi addresses from 21,953 verified blocks if not already done (~25-30 minutes first time)
- Includes Genesis block and early Satoshi addresses (blocks 0-2)
- Scans the entire blockchain for tainted transactions
- Updates the database with all connections

The application will be available at:

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## 🔬 Patoshi Pattern Analysis

This project uses **verified Patoshi blocks** to identify addresses belonging to Satoshi Nakamoto.

### What is Patoshi?

"Patoshi" refers to a unique mining pattern discovered by **Sergio Demian Lerner** in 2013 that identifies blocks mined by Satoshi Nakamoto with high confidence.

**Key Identifying Patterns:**

1. **Nonce LSB Pattern**: The last byte of the nonce is ALWAYS in ranges 0-9 or 19-58 (not 10-18 or 59-255 like other miners)
2. **ExtraNonce Increment**: Increments ~5x faster than normal (only scans 1/5 of nonce space)
3. **No Timestamp Reversals**: Satoshi's blocks never have backwards timestamps

**Dataset Used:**

- **21,953 verified Patoshi blocks** (blocks 3-49,973)
- **Plus early Satoshi blocks** (blocks 0-2): Genesis block and first mined blocks
- Curated by Sergio Demian Lerner & Jameson Lopp
- Source: https://github.com/bensig/patoshi-addresses
- Research: https://bitslog.com/2013/04/17/the-well-deserved-fortune-of-satoshi-nakamoto/

**Address Extraction Process:**

The application automatically extracts coinbase addresses when you run `npm run update-satoshi-data`:

- Iterates through all 21,953 verified Patoshi block heights
- Includes Genesis block (1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa) and blocks 1-2
- Extracts coinbase addresses (mining rewards) from each block
- Generates `backend/data/satoshiAddresses.js` with ~21,956 addresses
- Takes approximately 25-30 minutes on first run
- Subsequent runs skip extraction if addresses are already present

## 📝 Updating Transaction Data

The application maintains a database of transactions connected to Satoshi's addresses. To update this data:

### Available Scripts

#### Backend Scripts

| Script                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `npm start`                   | Start the production server                                     |
| `npm run dev`                 | Start development server with hot reload                        |
| `npm run check-node`          | Check Bitcoin node RPC status                                   |
| `npm run update-satoshi-data` | **Extract addresses & scan blockchain** (fully automated)       |
| `npm run check-satoshi-data`  | View taint database statistics                                  |

The `update-satoshi-data` script is fully automated and includes:

- **Automatic address extraction** (if not already done)
  - Extracts ~21,956 addresses from Genesis block + 21,953 Patoshi blocks
  - Takes 25-30 minutes on first run, skipped on subsequent runs
- **Blockchain scanning**
  - Scans entire blockchain for tainted transactions
  - Tracks Bitcoin flow from Satoshi addresses to all connected addresses
- **Performance optimizations**
  - Automatic garbage collection with `--expose-gc`
  - 8GB heap allocation with `--max-old-space-size=8192`
  - Transaction batch processing
  - Progress monitoring with visual feedback
  - Automatic retry mechanism with exponential backoff
  - Memory usage monitoring

#### Frontend Scripts

| Script          | Description              | Command      |
| --------------- | ------------------------ | ------------ |
| `npm run dev`   | Start development server | `next dev`   |
| `npm run build` | Build for production     | `next build` |
| `npm run start` | Start production server  | `next start` |
| `npm run lint`  | Run ESLint               | `next lint`  |

### Running the Application

1. Start the backend development server:

```bash
cd backend
npm run dev
```

2. Start the frontend development server:

```bash
cd frontend
npm run dev
```

3. Initialize or update the Satoshi transaction database (fully automated):

```bash
cd backend
npm run update-satoshi-data
```

This command automatically:
- Extracts Patoshi addresses (first time only, ~25-30 min)
- Scans the blockchain for all tainted transactions
- Updates the database with new connections

4. Check taint database statistics:

```bash
cd backend
npm run check-satoshi-data
```

The application will be available at:

- Frontend: http://localhost:3000 (default)
- Backend API: http://localhost:3001 (default)

## 📝 API Endpoints

### GET `/api/check/:address`

Check if a Bitcoin address has any connection to Satoshi's wallets.

**Response:**

```json
{
  "isConnected": boolean,
  "isSatoshiAddress": boolean,
  "degree": number,
  "note": string,
  "connectionPath": [
    {
      "from": string,
      "to": string,
      "txHash": string,
      "amount": number
    }
  ]
}
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## ⚠️ Notes

- This tool tracks outgoing transactions from Satoshi's known addresses to avoid false positives from people sending coins to Satoshi's addresses.
- The initial database build can take several hours depending on your Bitcoin node and system performance.
- The application supports all types of Bitcoin addresses (Legacy P2PKH, P2SH, and Native SegWit).
- While Satoshi only used P2PKH addresses, the tracking system follows coins through all address types to maintain complete traceability.

## 🚀 Performance Optimization

### Bitcoin Core Configuration

Add these settings to your bitcoin.conf for optimal performance:

```conf
# RPC Settings
rpcworkqueue=128     # Increased queue for parallel requests
rpcthreads=8        # Adjust based on CPU cores
rpctimeout=60       # Increased timeout for complex queries

# Performance Settings
dbcache=4096        # Adjust based on available RAM (MB)
par=8               # Parallel script verification threads
maxconnections=125  # Default is good for most cases
txindex=1          # Required for transaction lookups
```

### Node.js Memory Management

The application uses advanced memory management techniques:

- Garbage collection optimization with `--expose-gc`
- Increased heap size with `--max-old-space-size`
- Transaction caching
- Batch processing
- Memory usage monitoring

### Main Script: `npm run update-satoshi-data`

This is the primary command for initializing and updating the database. It's fully automated:

```bash
node --expose-gc --max-old-space-size=8192 src/scripts/updateSatoshiData.js
```

**What it does automatically:**

1. **Address Extraction** (first run only, ~25-30 minutes)
   - Extracts addresses from Genesis block (block 0)
   - Extracts addresses from early Satoshi blocks (1-2)
   - Extracts addresses from 21,953 verified Patoshi blocks (3-49,973)
   - Generates `data/satoshiAddresses.js` with ~21,956 addresses

2. **Blockchain Scanning** (several hours depending on system)
   - Scans entire blockchain chronologically
   - Identifies all addresses that received Bitcoin from Satoshi
   - Tracks multi-hop connections (taint propagation)
   - Stores transaction paths in LevelDB

**Performance optimizations:**

- Automatic garbage collection with `--expose-gc`
- 8GB heap size allocation with `--max-old-space-size=8192`
- Transaction caching
- Parallel block processing
- Memory usage monitoring
- Automatic retry with exponential backoff

### System Requirements

Recommended hardware for optimal performance:

- CPU: 4+ cores
- RAM: 16GB+ (32GB recommended)
- Storage: SSD/NVMe with 10GB+ free space
- Network: Stable connection with good bandwidth

## Environment Variables

### Backend Variables

| Variable                   | Description                                   | Default     |
| -------------------------- | --------------------------------------------- | ----------- |
| `PORT`                     | Server port                                   | `3001`      |
| `FRONTEND_URL`             | Frontend URL for CORS                         | -           |
| `NODE_ENV`                 | Environment (development/production)          | -           |
| `BITCOIN_RPC_HOST`         | Bitcoin node hostname                         | `localhost` |
| `BITCOIN_RPC_PORT`         | Bitcoin node RPC port                         | `8332`      |
| `BITCOIN_RPC_USER`         | Bitcoin node RPC username                     | -           |
| `BITCOIN_RPC_PASS`         | Bitcoin node RPC password                     | -           |
| `BITCOIN_RPC_TIMEOUT`      | RPC request timeout in milliseconds           | `60000`     |
| `DB_PATH`                  | Path to store the database files              | `./data`    |
| `MAX_DEGREE`               | Maximum number of transaction hops to track   | `100`       |
| `BATCH_SIZE`               | Number of transactions to process in parallel | `250`       |
| `BITCOIN_MAX_RETRIES`      | Maximum retry attempts                        | `5`         |
| `BITCOIN_MEMORY_THRESHOLD` | Memory usage threshold for GC                 | `0.90`      |
| `BITCOIN_BLOCK_TIMEOUT`    | Block processing timeout in milliseconds      | `300000`    |

### Frontend Variables

| Variable                       | Description              | Default                 |
| ------------------------------ | ------------------------ | ----------------------- |
| `NEXT_PUBLIC_API_URL`          | Backend API URL          | `http://localhost:3001` |
| `NEXT_PUBLIC_DONATION_ADDRESS` | Bitcoin donation address | -                       |
| `NEXT_PUBLIC_REPOSITORY_URL`   | GitHub repository URL    | -                       |
