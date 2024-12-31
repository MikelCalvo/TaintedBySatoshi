import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import {
  Container,
  Box,
  Typography,
  Button,
  Alert,
  AlertTitle,
  Chip,
  List,
  ListItem,
  Paper,
  Divider,
  Stack,
  CircularProgress,
} from "@mui/material";
import { ArrowBack, ArrowForward } from "@mui/icons-material";
import AddressSearchForm from "../../components/AddressSearchForm";
import { useState, useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function getServerSideProps({ params }) {
  return {
    props: {
      address: params.address,
      initialLoad: true,
    },
  };
}

const formatBTC = (satoshis) => {
  return (satoshis / 100000000).toFixed(8);
};

const getDegreeDescription = (degree) => {
  if (degree === 0) return "This is Satoshi's wallet";
  if (degree === 1) return "Directly received from Satoshi";
  if (degree === 2)
    return "Received from an address that received from Satoshi";
  return `Received through ${degree} levels of transactions from Satoshi`;
};

const ConnectionPath = ({ path }) => (
  <List>
    {path.map((step, index) => (
      <ListItem key={index} sx={{ mb: 2 }}>
        <Paper
          elevation={1}
          sx={{
            p: 3,
            width: "100%",
            bgcolor: index === 0 ? "primary.50" : "background.paper",
          }}
        >
          <Stack spacing={2}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Chip
                label={`Step ${index + 1}`}
                color={index === 0 ? "primary" : "default"}
                size="small"
              />
              <Typography variant="body2" color="text.secondary">
                {formatBTC(step.amount)} BTC
              </Typography>
            </Box>

            <Box>
              <Typography variant="body2" color="text.secondary">
                From:
              </Typography>
              <Link href={`/address/${step.from}`} passHref>
                <Typography
                  component="a"
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    color: "primary.main",
                    textDecoration: "none",
                    "&:hover": {
                      textDecoration: "underline",
                    },
                  }}
                >
                  {step.from}
                  {index === 0 && (
                    <Chip
                      label="Satoshi"
                      color="primary"
                      size="small"
                      sx={{ ml: 1 }}
                    />
                  )}
                </Typography>
              </Link>
            </Box>

            <ArrowForward color="action" />

            <Box>
              <Typography variant="body2" color="text.secondary">
                To:
              </Typography>
              <Link href={`/address/${step.to}`} passHref>
                <Typography
                  component="a"
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    color: "primary.main",
                    textDecoration: "none",
                    "&:hover": {
                      textDecoration: "underline",
                    },
                  }}
                >
                  {step.to}
                </Typography>
              </Link>
            </Box>

            <Typography variant="caption" color="text.secondary">
              Transaction: {step.txHash}
            </Typography>
          </Stack>
        </Paper>
      </ListItem>
    ))}
  </List>
);

export default function AddressPage({ address, initialLoad }) {
  const [isLoading, setIsLoading] = useState(initialLoad);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const router = useRouter();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

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

        const result = await retryWithBackoff(async () => {
          const response = await fetch(`${API_URL}/api/check/${address}`, {
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
    }
  }, [address, initialLoad]);

  if (isLoading) {
    return (
      <Container maxWidth="md" sx={{ py: 10 }}>
        <Box>
          <Link href="/" passHref>
            <Button startIcon={<ArrowBack />} sx={{ mb: 2 }}>
              Back
            </Button>
          </Link>
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
            This may take a few moments
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
          component={Link}
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
      <Head>
        <title>{address} - Tainted By Satoshi</title>
        <meta
          name="description"
          content={`Check if Bitcoin address ${address} has any connection to Satoshi Nakamoto's wallets`}
        />
      </Head>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={4}>
          <Box>
            <Link href="/" passHref>
              <Button startIcon={<ArrowBack />} sx={{ mb: 2 }}>
                Back
              </Button>
            </Link>
            <Typography variant="h4" gutterBottom>
              Address Details
            </Typography>
            <Typography variant="body1" sx={{ fontFamily: "monospace" }}>
              {address}
            </Typography>
          </Box>

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
                    <Box>
                      <Chip
                        label="Satoshi's Wallet"
                        color="primary"
                        sx={{ px: 2, py: 1 }}
                      />
                    </Box>
                    <Typography>
                      This is one of Satoshi Nakamoto's known addresses.{" "}
                      {data.note}
                    </Typography>
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
                    <Box>
                      <Typography variant="h5" gutterBottom>
                        Connection Status:{" "}
                        <Typography
                          component="span"
                          color={
                            data.isConnected ? "success.main" : "error.main"
                          }
                        >
                          {data.isConnected
                            ? "Connected to Satoshi"
                            : "No connection to Satoshi found"}
                        </Typography>
                      </Typography>
                      {data.isConnected && (
                        <Typography color="text.secondary">
                          {getDegreeDescription(data.degree)}
                        </Typography>
                      )}
                    </Box>

                    {data.isConnected ? (
                      <>
                        <Divider />
                        <Box>
                          <Typography variant="h6" gutterBottom>
                            Transaction Path:
                          </Typography>
                          <ConnectionPath path={data.connectionPath} />
                        </Box>
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
