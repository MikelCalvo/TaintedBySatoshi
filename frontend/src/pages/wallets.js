import { useEffect, useState } from "react";
import NextLink from "next/link";
import {
  Box,
  Button,
  Container,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import SEO from "../components/SEO";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export default function WalletsPage() {
  const [wallets, setWallets] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWallets = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`${API_URL}/api/wallets?${params}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(response.statusText);
        const data = await response.json();
        setWallets((current) =>
          cursor ? [...current, ...(data.wallets || [])] : data.wallets || []
        );
        setNextCursor(data.nextCursor || null);
        setError(null);
      } catch (err) {
        setError(err.message || "Failed to load tainted wallets");
      } finally {
        setLoading(false);
      }
    };

    fetchWallets();
  }, [cursor]);

  return (
    <>
      <SEO
        title="Tainted Wallets"
        description="Browse Bitcoin wallets connected to Satoshi Nakamoto and the hop count of each connection."
        path="/wallets"
      />
      <Container maxWidth="lg" sx={{ py: 6 }}>
        <Link component={NextLink} href="/" underline="hover" color="text.secondary">
          &larr; Back to search
        </Link>
        <Typography variant="h4" sx={{ mt: 2, mb: 1 }}>
          Tainted wallets
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Every wallet that received coins originating from a Patoshi/Satoshi
          coinbase, with the shortest hop count found so far.
        </Typography>

        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        <Paper>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Address</TableCell>
                <TableCell>Hops</TableCell>
                <TableCell>Parent</TableCell>
                <TableCell>Origin</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {wallets.map((wallet) => (
                <TableRow key={wallet.address} hover>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    <Link
                      component={NextLink}
                      href={`/address/${encodeURIComponent(wallet.address)}`}
                    >
                      {wallet.address}
                    </Link>
                  </TableCell>
                  <TableCell>{wallet.hops}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {wallet.parent || "—"}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {wallet.origin || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>

        <Box sx={{ mt: 2, display: "flex", justifyContent: "center" }}>
          {nextCursor ? (
            <Button
              variant="outlined"
              disabled={loading}
              onClick={() => setCursor(nextCursor)}
            >
              {loading ? "Loading..." : "Load more"}
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {loading ? "Loading..." : `${wallets.length.toLocaleString()} wallets`}
            </Typography>
          )}
        </Box>
      </Container>
    </>
  );
}
