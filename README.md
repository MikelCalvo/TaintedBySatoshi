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
git clone https://github.com/yourusername/TaintedBySatoshi.git
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
MAX_DEGREE=100           # Maximum tinting degree to process
BATCH_SIZE=100          # Number of transactions to process in parallel
CACHE_TTL=3600         # Cache time-to-live in seconds
UPDATE_INTERVAL=3600   # How often to update the database in seconds
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

2. Check your Bitcoin node status:

```bash
cd backend
npm run check-node
```

This will show:

- Node connection status and version
- Sync progress and estimated time remaining
- Mempool status and size
- Transaction indexing status

Make sure your node is fully synced and has txindex enabled before proceeding.

3. Start the backend server:

```bash
cd backend
npm run dev
```

4. Start the frontend development server:

```bash
cd frontend
npm run dev
```

5. Initialize the Satoshi transaction database:

```bash
cd backend
npm run update-satoshi-data
```

The application will be available at:

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## 📝 Updating Transaction Data

The application maintains a database of transactions connected to Satoshi's addresses. To update this data:

### Available Scripts

#### `npm run check-node`

Checks the status of your Bitcoin Core node, including:

- Connection status and peer count
- Blockchain sync progress
- Estimated time remaining for sync
- Mempool status and size
- Transaction index (txindex) status

Use this script to verify your node is properly configured and ready for use.

#### `npm run update-satoshi-data`

Updates the local database with the latest Satoshi-related transactions:

- Scans known Satoshi addresses for new transactions
- Updates the connection graph
- Maintains the transaction history database

Run this script periodically to keep the database current with new transactions.

This process can take several hours on the first run as it needs to scan the entire blockchain for relevant transactions.

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
