import Head from "next/head";
import { Container, Box, Typography } from "@mui/material";
import AddressSearchForm from "../components/AddressSearchForm";

export default function Home() {
  return (
    <>
      <Head>
        <title>Tainted By Satoshi - Check Bitcoin Address Connections</title>
        <meta
          name="description"
          content="Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets"
        />
      </Head>

      <Container maxWidth="md" sx={{ py: 10 }}>
        <Box sx={{ textAlign: "center", mb: 6 }}>
          <Typography variant="h2" component="h1" gutterBottom>
            Tainted By Satoshi
          </Typography>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            Check if a Bitcoin address has any connection to Satoshi Nakamoto's
            wallets
          </Typography>
        </Box>

        <AddressSearchForm showNote={true} />
      </Container>
    </>
  );
}
