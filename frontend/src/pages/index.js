import { Container, Box, Typography } from "@mui/material";
import AddressSearchForm from "../components/AddressSearchForm";
import FamousWalletsSuggestions from "../components/FamousWalletsSuggestions";
import SEO from "../components/SEO";

export default function Home() {
  return (
    <>
      <SEO
        title="Check Bitcoin Address Connections"
        description="Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets through transaction history. Track direct and indirect connections."
        path="/"
      />

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

        <FamousWalletsSuggestions />
      </Container>
    </>
  );
}
