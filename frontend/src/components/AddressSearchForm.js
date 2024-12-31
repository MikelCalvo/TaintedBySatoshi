import { useState } from "react";
import { useRouter } from "next/router";
import {
  TextField,
  Button,
  IconButton,
  InputAdornment,
  Box,
  Typography,
} from "@mui/material";
import { Search as SearchIcon, Clear as ClearIcon } from "@mui/icons-material";
import { isValidBitcoinAddress } from "../utils/validation";

export default function AddressSearchForm({ showNote = false }) {
  const [address, setAddress] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSearch = async (e) => {
    e.preventDefault();
    setIsValidating(true);
    setError("");

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

    // Valid address, proceed with search
    router.push(`/address/${trimmedAddress}`);
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
