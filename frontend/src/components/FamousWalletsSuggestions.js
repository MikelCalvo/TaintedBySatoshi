import Link from "next/link";
import { useState } from "react";
import { Box, Typography, Paper, Stack, Divider } from "@mui/material";
import { FAMOUS_WALLETS } from "../data/famousWallets";

const INITIAL_COUNT = 3;
const LOAD_MORE_COUNT = 5;

const CategoryWallets = ({ category, wallets }) => {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);

  const visibleWallets = wallets.slice(0, visibleCount);
  const hasMore = visibleCount < wallets.length;
  const remaining = wallets.length - visibleCount;

  return (
    <Box>
      <Typography
        variant="subtitle1"
        sx={{
          mb: 2,
          fontWeight: 600,
          color: "primary.main",
          fontSize: "1.1rem",
        }}
      >
        {category}
      </Typography>
      <Stack spacing={1}>
        {visibleWallets.map((wallet) => (
          <Paper
            key={wallet.address}
            elevation={0}
            sx={{
              p: 2.5,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "primary.dark",
              borderRadius: 1,
              "&:hover": {
                bgcolor: "rgba(5, 217, 232, 0.1)",
                borderColor: "primary.main",
                boxShadow: "0 0 10px rgba(5, 217, 232, 0.3)",
                transform: "translateY(-2px)",
              },
              transition: "all 0.3s ease",
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
                <Typography
                  variant="body1"
                  sx={{
                    fontWeight: 600,
                    color: "text.primary",
                    mb: 0.5,
                  }}
                >
                  {wallet.name}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: "monospace",
                    color: "primary.main",
                    wordBreak: "break-all",
                    fontSize: "0.75rem",
                    display: "block",
                    opacity: 0.9,
                  }}
                >
                  {wallet.address}
                </Typography>
              </Box>
            </Link>
          </Paper>
        ))}
        {hasMore && (
          <Typography
            onClick={() => setVisibleCount(prev => prev + LOAD_MORE_COUNT)}
            sx={{
              color: "primary.main",
              cursor: "pointer",
              textAlign: "center",
              py: 1,
              fontSize: "0.875rem",
              "&:hover": {
                textDecoration: "underline",
              },
            }}
          >
            Show {Math.min(remaining, LOAD_MORE_COUNT)} more...
          </Typography>
        )}
      </Stack>
    </Box>
  );
};

const FamousWalletsSuggestions = () => (
  <Box sx={{ mt: 8 }}>
    <Divider sx={{ mb: 4 }} />
    <Typography variant="h5" gutterBottom sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      Explore Famous Bitcoin Wallets
    </Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
      Try checking the connection to Satoshi for these well-known addresses:
    </Typography>

    <Stack spacing={3}>
      {FAMOUS_WALLETS.map((category) => (
        <CategoryWallets
          key={category.category}
          category={category.category}
          wallets={category.wallets}
        />
      ))}
    </Stack>
  </Box>
);

export default FamousWalletsSuggestions;
