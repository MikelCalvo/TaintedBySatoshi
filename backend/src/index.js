require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { checkAddressConnection } = require('./services/bitcoinService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Check if an address is connected to Satoshi
app.get('/api/check/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const result = await checkAddressConnection(address);
    res.json(result);
  } catch (error) {
    console.error('Error checking address:', error);
    res.status(500).json({ error: 'Failed to check address connection' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 