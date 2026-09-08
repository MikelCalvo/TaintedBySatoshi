import { Container, Box, Typography, Link } from "@mui/material";
import NextLink from "next/link";
import AddressSearchForm from "../components/AddressSearchForm";
import FamousWalletsSuggestions from "../components/FamousWalletsSuggestions";
import SEO from "../components/SEO";

export default function Home() {
  return (
    <>
      <SEO
        title="Check Bitcoin Address Connections"
        description="Browse Bitcoin wallets connected to Satoshi Nakamoto and the hop count of each connection."
        path="/"
      />

      <Container maxWidth="md" sx={{ py: 10 }}>
        <Box sx={{ textAlign: "center", mb: 6 }}>
          <Typography variant="h2" component="h1" gutterBottom>
            Tainted By Satoshi
          </Typography>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            List every Bitcoin wallet connected to Satoshi Nakamoto and the hop
            count of that connection
          </Typography>
        </Box>

        <AddressSearchForm showNote={true} />

        <Box sx={{ textAlign: "center", mb: 6 }}>
          <Typography variant="body2">
            <Link component={NextLink} href="/wallets" underline="hover">
              Browse all tainted wallets
            </Link>
          </Typography>
        </Box>

        <FamousWalletsSuggestions />
      </Container>
    </>
  );
}
