const axios = require('axios');

class BitcoinRPC {
  constructor() {
    this.host = process.env.BITCOIN_RPC_HOST || 'localhost';
    this.port = process.env.BITCOIN_RPC_PORT || 8332;
    this.user = process.env.BITCOIN_RPC_USER;
    this.pass = process.env.BITCOIN_RPC_PASS;
    this.timeout = parseInt(process.env.BITCOIN_RPC_TIMEOUT) || 30000;

    if (!this.user || !this.pass) {
      throw new Error('Bitcoin RPC credentials not configured');
    }

    this.client = axios.create({
      baseURL: `http://${this.host}:${this.port}`,
      auth: {
        username: this.user,
        password: this.pass
      },
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async call(method, params = []) {
    try {
      const response = await this.client.post('/', {
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params
      });

      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      return response.data.result;
    } catch (error) {
      console.error(`Bitcoin RPC error (${method}):`, error.message);
      throw error;
    }
  }

  // Get transaction details
  async getTransaction(txid) {
    const tx = await this.call('getrawtransaction', [txid, true]);
    return this.formatTransaction(tx);
  }

  // Get address transactions
  async getAddressTransactions(address) {
    // First, get transactions referencing this address
    const txids = await this.call('searchrawtransactions', [address, 1, 0, 100, true]);
    return txids.map(this.formatTransaction);
  }

  // Format transaction to match our expected structure
  formatTransaction(tx) {
    return {
      hash: tx.txid,
      time: tx.time,
      inputs: tx.vin.map(input => ({
        prev_out: {
          addr: input.address,
          value: Math.round(input.value * 100000000) // Convert BTC to satoshis
        }
      })),
      out: tx.vout.map(output => ({
        addr: output.scriptPubKey.addresses?.[0],
        value: Math.round(output.value * 100000000) // Convert BTC to satoshis
      })).filter(out => out.addr) // Filter out non-standard outputs
    };
  }

  // Batch process multiple transactions
  async batchGetTransactions(txids) {
    const batchSize = parseInt(process.env.BATCH_SIZE) || 100;
    const results = [];
    
    for (let i = 0; i < txids.length; i += batchSize) {
      const batch = txids.slice(i, i + batchSize);
      const promises = batch.map(txid => this.getTransaction(txid));
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    return results;
  }
}

// Export singleton instance
module.exports = new BitcoinRPC(); 