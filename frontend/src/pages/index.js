import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import {
  Container,
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  InputAdornment,
} from '@mui/material';
import { Search as SearchIcon, Clear as ClearIcon } from '@mui/icons-material';
import { isValidBitcoinAddress } from '../utils/validation';

export default function Home() {
  const [address, setAddress] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSearch = async (e) => {
    e.preventDefault();
    setIsValidating(true);
    setError('');

    const trimmedAddress = address.trim();
    
    if (!trimmedAddress) {
      setError('Please enter a Bitcoin address');
      setIsValidating(false);
      return;
    }

    if (!isValidBitcoinAddress(trimmedAddress)) {
      setError('Please enter a valid Bitcoin address (starting with 1, 3, or bc1)');
      setIsValidating(false);
      return;
    }

    // Valid address, proceed with search
    router.push(`/address/${trimmedAddress}`);
  };

  const handleClear = () => {
    setAddress('');
    setError('');
  };

  return (
    <>
      <Head>
        <title>Tinted By Satoshi - Check Bitcoin Address Connections</title>
        <meta name="description" content="Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets" />
      </Head>

      <Container maxWidth="md" sx={{ py: 10 }}>
        <Box sx={{ textAlign: 'center', mb: 6 }}>
          <Typography variant="h2" component="h1" gutterBottom>
            Tinted By Satoshi
          </Typography>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets
          </Typography>
        </Box>

        <Box component="form" onSubmit={handleSearch} sx={{ maxWidth: 600, mx: 'auto' }}>
          <TextField
            fullWidth
            placeholder="Enter Bitcoin address"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError('');
            }}
            error={!!error}
            helperText={error}
            InputProps={{
              endAdornment: address && (
                <InputAdornment position="end">
                  <IconButton onClick={handleClear} edge="end">
                    <ClearIcon />
                  </IconButton>
                </InputAdornment>
              ),
            }}
            sx={{ mb: 2 }}
          />

          <Button
            fullWidth
            variant="contained"
            type="submit"
            disabled={isValidating}
            startIcon={<SearchIcon />}
            sx={{ mb: 4 }}
          >
            {isValidating ? 'Searching...' : 'Search'}
          </Button>

          <Typography variant="body2" color="text.secondary" align="center">
            Note: This tool only tracks outgoing transactions from Satoshi's known addresses to avoid false positives.
            <br />
            New transactions could take up to 24 hours to appear in the results.
          </Typography>
        </Box>
      </Container>
    </>
  );
} 