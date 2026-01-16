import { useRouter } from "next/router";
import NextLink from "next/link";
import SEO from "../../components/SEO";
import {
  Container,
  Box,
  Typography,
  Button,
  Alert,
  AlertTitle,
  Chip,
  Paper,
  Divider,
  Stack,
  CircularProgress,
  Link,
} from "@mui/material";
import { ArrowBack, Info } from "@mui/icons-material";
import AddressSearchForm from "../../components/AddressSearchForm";
import { useState, useEffect } from "react";
import FamousWalletsSuggestions from "../../components/FamousWalletsSuggestions";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function getServerSideProps({ params }) {
  return {
    props: {
      address: params.address,
      initialLoad: true,
    },
  };
}

const getDegreeDescription = (degree) => {
  if (degree === 0) return "This is Satoshi's wallet";
  if (degree === 1) return "1 hop away - received directly from Satoshi";
  if (degree === 2) return "2 hops away from Satoshi";
  return `${degree} hops away from Satoshi`;
};

export default function AddressPage({ address, initialLoad }) {
  const [isLoading, setIsLoading] = useState(initialLoad);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const router = useRouter();

  useEffect(() => {
    const retryWithBackoff = async (fn, retries = 2) => {
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (error) {
          if (i === retries - 1) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, (i + 1) * 1000)
          );
        }
      }
    };

    const fetchSyncStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/api/sync-status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json();
          setSyncStatus(data);
        }
      } catch {
        // Silently fail - sync status is informational
      }
    };

    const fetchData = async () => {
      try {
        const result = await retryWithBackoff(async () => {
          // Encode address to prevent URL injection
          const encodedAddress = encodeURIComponent(address);
          const response = await fetch(`${API_URL}/api/check/${encodedAddress}`, {
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-cache",
            },
          });

          if (!response.ok) {
            throw new Error(response.statusText);
          }

          return response.json();
        });

        setData(result);
        setError(null);
      } catch (err) {
        setError({
          title: "Error",
          description: err.message || "Failed to check address connection",
        });
      } finally {
        setIsLoading(false);
      }
    };

    if (initialLoad) {
      fetchData();
      fetchSyncStatus();
    }
  }, [address, initialLoad]);

  if (isLoading) {
    return (
      <Container maxWidth="md" sx={{ py: 10 }}>
        <Box>
          <NextLink href="/" passHref>
            <Button startIcon={<ArrowBack />} sx={{ mb: 2 }}>
              Back
            </Button>
          </NextLink>
          <Typography variant="h4" gutterBottom>
            Address Details
          </Typography>
          <Typography variant="body1" sx={{ fontFamily: "monospace", mb: 4 }}>
            {address}
          </Typography>
        </Box>
        <Paper sx={{ p: 4, textAlign: "center" }}>
          <CircularProgress size={40} sx={{ mb: 2 }} />
          <Typography>
            Checking address connection to Satoshi's wallets...
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This may take a moment
          </Typography>
        </Paper>
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth="md" sx={{ py: 10 }}>
        <Alert severity="error" sx={{ mb: 4 }}>
          <AlertTitle>{error.title}</AlertTitle>
          {error.description}
        </Alert>
        <Button
          component={NextLink}
          href="/"
          startIcon={<ArrowBack />}
          sx={{ mt: 2 }}
        >
          Back to Search
        </Button>
      </Container>
    );
  }

  return (
    <>
      <SEO
        title={address}
        description={`Check if Bitcoin address ${address} has any connection to Satoshi Nakamoto's wallets through transaction history.`}
        path={`/address/${address}`}
      />

      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={4}>
          <Box>
            <NextLink href="/" passHref>
              <Button startIcon={<ArrowBack />} sx={{ mb: 2 }}>
                Back
              </Button>
            </NextLink>
            <Typography variant="h4" gutterBottom>
              Address Details
            </Typography>
            <Typography variant="body1" sx={{ fontFamily: "monospace" }}>
              {address}
            </Typography>
          </Box>

          {syncStatus && syncStatus.lastProcessedBlock === null && (
            <Alert severity="warning" icon={<Info />}>
              <AlertTitle>Service initializing</AlertTitle>
              The sync service is starting up and reading the local database.
              Results may be incomplete. Please wait a moment and refresh.{" "}
              <Link component={NextLink} href="/status" underline="hover">
                View sync status
              </Link>
            </Alert>
          )}

          {syncStatus && syncStatus.lastProcessedBlock !== null && syncStatus.blocksBehind > 0 && (
            <Alert severity="info" icon={<Info />}>
              <AlertTitle>Sync in progress</AlertTitle>
              The database is currently synced up to block{" "}
              {syncStatus.lastProcessedBlock.toLocaleString()} of{" "}
              {syncStatus.currentHeight?.toLocaleString()} ({syncStatus.progress}
              ). If you are looking for a recent transaction, please check again
              later.{" "}
              <Link component={NextLink} href="/status" underline="hover">
                View sync status
              </Link>
            </Alert>
          )}

          {error && (
            <Alert
              severity="warning"
              sx={{
                "& .MuiAlert-message": {
                  width: "100%",
                },
              }}
            >
              <AlertTitle>{error.title}</AlertTitle>
              {error.description}
            </Alert>
          )}

          {data && (
            <Paper sx={{ p: 4 }}>
              <Stack spacing={4}>
                {data.isSatoshiAddress ? (
                  <>
                    <Box sx={{ textAlign: "center" }}>
                      <Chip
                        label="Satoshi's Wallet"
                        color="primary"
                        sx={{
                          px: 3,
                          py: 2.5,
                          fontSize: "1.1rem",
                          fontWeight: 600,
                          mb: 2,
                        }}
                      />
                      <Typography
                        variant="h4"
                        sx={{
                          color: "primary.main",
                          fontWeight: 700,
                        }}
                      >
                        This is one of Satoshi Nakamoto's known addresses
                      </Typography>
                      {data.note && (
                        <Typography
                          variant="body1"
                          color="text.secondary"
                          sx={{ mt: 1 }}
                        >
                          {data.note}
                        </Typography>
                      )}
                    </Box>
                    <Divider />
                    <Box>
                      <Typography variant="body1" align="center" sx={{ mb: 4 }}>
                        Try searching for a different address:
                      </Typography>
                      <AddressSearchForm />
                    </Box>
                  </>
                ) : (
                  <>
                    <Box sx={{ textAlign: "center" }}>
                      {data.isConnected ? (
                        <>
                          <Chip
                            label="Connected to Satoshi"
                            color="success"
                            sx={{
                              px: 3,
                              py: 2.5,
                              fontSize: "1.1rem",
                              fontWeight: 600,
                              mb: 2,
                            }}
                          />
                          <Typography
                            variant="h4"
                            sx={{
                              color: "primary.main",
                              fontWeight: 700,
                            }}
                          >
                            {getDegreeDescription(data.degree)}
                          </Typography>
                        </>
                      ) : (
                        <Chip
                          label="No connection to Satoshi found"
                          color="error"
                          sx={{
                            px: 3,
                            py: 2.5,
                            fontSize: "1.1rem",
                            fontWeight: 600,
                          }}
                        />
                      )}
                    </Box>

                    {data.isConnected ? (
                      <>
                        <Divider />
                        <Box>
                          <Typography
                            variant="body1"
                            align="center"
                            sx={{ mb: 4 }}
                          >
                            Try searching for a different address:
                          </Typography>
                          <AddressSearchForm />
                        </Box>
                      </>
                    ) : (
                      <>
                        <Divider />
                        <Box>
                          <Typography
                            variant="body1"
                            align="center"
                            sx={{ mb: 4 }}
                          >
                            Try searching for a different address:
                          </Typography>
                          <AddressSearchForm />
                          <FamousWalletsSuggestions />
                        </Box>
                      </>
                    )}
                  </>
                )}
              </Stack>
            </Paper>
          )}
        </Stack>
      </Container>
    </>
  );
}
