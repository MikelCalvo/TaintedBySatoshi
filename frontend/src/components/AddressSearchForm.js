import { useState } from "react";
import {
  TextField,
  Button,
  IconButton,
  InputAdornment,
  Box,
  Typography,
  CircularProgress,
} from "@mui/material";
import { Search as SearchIcon, Clear as ClearIcon } from "@mui/icons-material";
import { isValidBitcoinAddress } from "../utils/validation";
import { useRouter } from "next/router";

export default function AddressSearchForm({ showNote = false }) {
  const [address, setAddress] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const retryWithBackoff = async (fn, retries = 2) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
      }
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setIsValidating(true);
    setError("");

    try {
      const trimmedAddress = address.trim();

      if (!trimmedAddress) {
        setError("Please enter a Bitcoin address");
        setIsValidating(false);
        return;
      }

      // Check address format first
      const isValidFormat =
        trimmedAddress.startsWith("1") ||
        trimmedAddress.startsWith("3") ||
        trimmedAddress.toLowerCase().startsWith("bc1");

      if (!isValidFormat) {
        setError(
          "Please enter a valid Bitcoin address (starting with 1, 3, or bc1)"
        );
        setIsValidating(false);
        return;
      }

      if (!isValidBitcoinAddress(trimmedAddress)) {
        setError(
          "Invalid Bitcoin address - the checksum verification failed. Please check for typos."
        );
        setIsValidating(false);
        return;
      }

      const API_URL =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

      try {
        await retryWithBackoff(async () => {
          const healthCheck = await fetch(`${API_URL}/api/health`, {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(3000),
          });

          if (!healthCheck.ok) {
            throw new Error("Backend service is not responding");
          }
        });

        // If health check passes, navigate to the address page
        await router.push(
          {
            pathname: "/address/[address]",
            query: { address: trimmedAddress },
          },
          undefined,
          { shallow: false }
        );
      } catch (error) {
        console.error("Health check error:", error);
        setError(
          "The service is temporarily slow to respond. Please try again in a moment."
        );
        setIsValidating(false);
        return;
      }
    } catch (error) {
      console.error("Search error:", error);
      setError("An error occurred while processing your request");
      setIsValidating(false);
    }
  };

  const handleClear = () => {
    setAddress("");
    setError("");
  };

  return (
    <Box
      component="form"
      onSubmit={handleSearch}
      sx={{ maxWidth: 600, mx: "auto" }}
    >
      <TextField
        fullWidth
        placeholder="Enter Bitcoin address"
        value={address}
        onChange={(e) => {
          setAddress(e.target.value);
          setError("");
        }}
        error={!!error}
        helperText={error}
        disabled={isValidating}
        InputProps={{
          endAdornment: address && (
            <InputAdornment position="end">
              <IconButton
                onClick={handleClear}
                edge="end"
                disabled={isValidating}
              >
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
        startIcon={
          isValidating ? <CircularProgress size={20} /> : <SearchIcon />
        }
        sx={{ mb: 4 }}
      >
        {isValidating ? "Searching..." : "Search"}
      </Button>

      {showNote && (
        <Typography variant="body2" color="text.secondary" align="center">
          Note: This tool only tracks outgoing transactions from Satoshi's known
          addresses to avoid false positives.
          <br />
          New transactions could take up to 24 hours to appear in the results.
        </Typography>
      )}
    </Box>
  );
}
