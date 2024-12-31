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
} from "@mui/material";
import { ArrowBack, ArrowForward } from "@mui/icons-material";
import AddressSearchForm from "../../components/AddressSearchForm";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function getServerSideProps({ params }) {
  try {
    const response = await fetch(`${API_URL}/api/check/${params.address}`);
    const data = await response.json();

    if (!response.ok) {
      return {
        props: {
          address: params.address,
          error: {
            title:
              response.status === 429
                ? "Rate Limit Exceeded"
                : "Error Checking Address",
            description:
              response.status === 429
                ? "We are currently gathering data from the Bitcoin network. Please try again in 24 hours."
                : data.error || "Failed to check address",
          },
        },
      };
    }

    return {
      props: {
        address: params.address,
        result: data,
      },
    };
  } catch (error) {
    return {
      props: {
        address: params.address,
        error: {
          title: "Error",
          description: "Failed to check address connection",
        },
      },
    };
  }
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

export default function AddressPage({ address, result, error }) {
  const router = useRouter();

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

          {result && (
            <Paper sx={{ p: 4 }}>
              <Stack spacing={4}>
                {result.isSatoshiAddress ? (
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
                      {result.note}
                    </Typography>
                  </>
                ) : (
                  <>
                    <Box>
                      <Typography variant="h5" gutterBottom>
                        Connection Status:{" "}
                        <Typography
                          component="span"
                          color={
                            result.isConnected ? "success.main" : "error.main"
                          }
                        >
                          {result.isConnected
                            ? "Connected to Satoshi"
                            : "No connection found"}
                        </Typography>
                      </Typography>
                      {result.isConnected && (
                        <Typography color="text.secondary">
                          {getDegreeDescription(result.degree)}
                        </Typography>
                      )}
                    </Box>

                    {result.isConnected ? (
                      <>
                        <Divider />
                        <Box>
                          <Typography variant="h6" gutterBottom>
                            Transaction Path:
                          </Typography>
                          <ConnectionPath path={result.connectionPath} />
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
