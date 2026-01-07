import Link from "next/link";
import { Box, Typography, Paper, Stack, Divider } from "@mui/material";
import { FAMOUS_WALLETS } from "../data/famousWallets";

const FamousWalletsSuggestions = () => (
  <Box sx={{ mt: 8 }}>
    <Divider sx={{ mb: 4 }} />
    <Typography variant="h5" gutterBottom sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      🔍 Explore Famous Bitcoin Wallets
    </Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
      Try checking the connection to Satoshi for these well-known addresses:
    </Typography>
    
    <Stack spacing={3}>
      {FAMOUS_WALLETS.map((category) => (
        <Box key={category.category}>
          <Typography 
            variant="subtitle1" 
            color="primary" 
            sx={{ mb: 1.5, fontWeight: 600 }}
          >
            {category.category}
          </Typography>
          <Stack spacing={1}>
            {category.wallets.map((wallet) => (
              <Paper
                key={wallet.address}
                elevation={0}
                sx={{
                  p: 2,
                  bgcolor: "grey.50",
                  border: "1px solid",
                  borderColor: "grey.200",
                  "&:hover": {
                    bgcolor: "grey.100",
                    borderColor: "primary.main",
                  },
                  transition: "all 0.2s ease",
                  cursor: "pointer",
                }}
              >
                <Link href={`/address/${wallet.address}`} passHref legacyBehavior>
                  <Box
                    component="a"
                    sx={{
                      textDecoration: "none",
                      display: "block",
                    }}
                  >
                    <Typography variant="body1" sx={{ fontWeight: 500, color: "text.primary" }}>
                      {wallet.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: "monospace",
                        color: "primary.main",
                        wordBreak: "break-all",
                      }}
                    >
                      {wallet.address}
                    </Typography>
                  </Box>
                </Link>
              </Paper>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  </Box>
);

export default FamousWalletsSuggestions;
