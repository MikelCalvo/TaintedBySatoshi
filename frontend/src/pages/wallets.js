import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import NextLink from "next/link";
import {
  Box,
  Button,
  Card,
  CardContent,
  Container,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import SEO from "../components/SEO";
import {
  SORT_OPTIONS,
  applyLoadedView,
  getEmptyState,
  getMatchSummary,
  getScopeCopy,
  isHopRangeValid,
  parseHopBound,
  shouldShowLoadMore,
} from "../utils/walletsExplorer.mjs";
import {
  createInitialWalletsSession,
  createWalletsLoader,
  reduceWalletsSession,
} from "../utils/walletsSession.mjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const wrappingSx = {
  fontFamily: "monospace",
  wordBreak: "break-all",
  overflowWrap: "anywhere",
  whiteSpace: "normal",
};

const touchButtonSx = {
  minHeight: 48,
  px: 2.5,
};

function WalletFields({ wallet }) {
  return (
    <>
      <Typography variant="caption" color="text.secondary">
        Address
      </Typography>
      <Typography sx={{ ...wrappingSx, mb: 1.5 }}>
        <Link
          component={NextLink}
          href={`/address/${encodeURIComponent(wallet.address)}`}
        >
          {wallet.address}
        </Link>
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Hops
      </Typography>
      <Typography sx={{ mb: 1.5 }}>{wallet.hops}</Typography>
      <Typography variant="caption" color="text.secondary">
        Parent
      </Typography>
      <Typography sx={{ ...wrappingSx, mb: 1.5 }}>
        {wallet.parent || "Not available"}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Origin
      </Typography>
      <Typography sx={wrappingSx}>{wallet.origin || "Not available"}</Typography>
    </>
  );
}

export default function WalletsPage() {
  const [session, dispatch] = useReducer(
    reduceWalletsSession,
    null,
    createInitialWalletsSession
  );
  const [hopError, setHopError] = useState("");
  const loaderRef = useRef(null);

  useEffect(() => {
    const loader = createWalletsLoader({ apiUrl: API_URL });
    loaderRef.current = loader;
    dispatch({ type: "reset" });
    loader.load({ apply: dispatch });
    return () => loader.abort();
  }, []);

  const visibleWallets = useMemo(
    () =>
      applyLoadedView(session.wallets, {
        sort: session.sort,
        minHops: session.minHops,
        maxHops: session.maxHops,
      }),
    [session.wallets, session.sort, session.minHops, session.maxHops]
  );

  const emptyState = getEmptyState({
    loading: session.loading,
    error: session.error,
    loadedCount: session.wallets.length,
    matchCount: visibleWallets.length,
    query: session.appliedQuery,
    minHops: session.minHops,
    maxHops: session.maxHops,
  });
  const showLoadMore = shouldShowLoadMore({
    nextCursor: session.nextCursor,
    matchCount: visibleWallets.length,
    loading: session.loading,
  });

  const applyHopDraft = (minValue, maxValue) => {
    const minHops = parseHopBound(minValue);
    const maxHops = parseHopBound(maxValue);
    if (!isHopRangeValid(minHops, maxHops)) {
      setHopError("Hop range must use nonnegative whole numbers, with min ≤ max.");
      return false;
    }
    setHopError("");
    dispatch({ type: "apply-hop-range", minHops, maxHops });
    return true;
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!applyHopDraft(session.draftMinHops, session.draftMaxHops)) return;
    const loader = loaderRef.current;
    if (!loader) return;
    dispatch({ type: "submit-search", query: session.draftQuery });
    loader.load({ q: session.draftQuery, apply: dispatch });
  };

  const handleReset = () => {
    const loader = loaderRef.current;
    if (!loader) return;
    setHopError("");
    dispatch({ type: "reset" });
    loader.load({ apply: dispatch });
  };

  const handleLoadMore = () => {
    const loader = loaderRef.current;
    if (!loader || !session.nextCursor) return;
    const cursor = session.nextCursor;
    dispatch({ type: "load-more" });
    loader.load({
      q: session.appliedQuery,
      cursor,
      append: true,
      apply: dispatch,
    });
  };

  return (
    <>
      <SEO
        title="Tainted Wallets"
        description="Browse Bitcoin wallets connected to Satoshi Nakamoto and the hop count of each connection."
        path="/wallets"
      />
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 6 }, px: { xs: 2, sm: 3 } }}>
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

        <Paper
          component="form"
          onSubmit={handleSubmit}
          sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}
        >
          <Stack spacing={2}>
            <TextField
              fullWidth
              label="Address prefix"
              placeholder="Case-sensitive address or prefix"
              value={session.draftQuery}
              onChange={(event) =>
                dispatch({ type: "set-draft-query", query: event.target.value })
              }
              slotProps={{
                htmlInput: {
                  "aria-label": "Address prefix",
                  autoComplete: "off",
                },
              }}
            />
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <FormControl fullWidth>
                <InputLabel id="wallets-sort-label">Sort</InputLabel>
                <Select
                  labelId="wallets-sort-label"
                  label="Sort"
                  value={session.sort}
                  onChange={(event) =>
                    dispatch({ type: "set-sort", sort: event.target.value })
                  }
                  sx={{ minHeight: 48 }}
                >
                  {SORT_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={2} sx={{ alignItems: { md: "flex-start" } }}>
              <TextField
                label="Min hops"
                value={session.draftMinHops}
                onChange={(event) => {
                  dispatch({
                    type: "set-draft-hops",
                    minHops: event.target.value,
                    maxHops: session.draftMaxHops,
                  });
                  applyHopDraft(event.target.value, session.draftMaxHops);
                }}
                sx={{ flex: 1, minWidth: 0 }}
                slotProps={{
                  htmlInput: {
                    inputMode: "numeric",
                    "aria-label": "Minimum hops on loaded results",
                  },
                }}
                error={Boolean(hopError)}
              />
              <TextField
                label="Max hops"
                value={session.draftMaxHops}
                onChange={(event) => {
                  dispatch({
                    type: "set-draft-hops",
                    minHops: session.draftMinHops,
                    maxHops: event.target.value,
                  });
                  applyHopDraft(session.draftMinHops, event.target.value);
                }}
                sx={{ flex: 1, minWidth: 0 }}
                slotProps={{
                  htmlInput: {
                    inputMode: "numeric",
                    "aria-label": "Maximum hops on loaded results",
                  },
                }}
                error={Boolean(hopError)}
                helperText={hopError}
              />
            </Stack>
            <Stack
              direction={{ xs: "row", sm: "row" }}
              spacing={1.5}
              sx={{ justifyContent: "flex-end" }}
            >
              <Button
                type="button"
                variant="outlined"
                onClick={handleReset}
                sx={{ ...touchButtonSx, flex: 1, minWidth: 0, minHeight: 48 }}
              >
                Reset
              </Button>
              <Button
                type="submit"
                variant="contained"
                sx={{ ...touchButtonSx, flex: 1, minWidth: 0, minHeight: 48 }}
              >
                Search
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {getScopeCopy()}
            </Typography>
            <Typography variant="body2">
              {getMatchSummary({
                matchCount: visibleWallets.length,
                loadedCount: session.wallets.length,
              })}
            </Typography>
          </Stack>
        </Paper>

        {session.error && emptyState?.kind !== "error" && (
          <Typography color="error" sx={{ mb: 2 }}>
            {session.error}
          </Typography>
        )}

        {emptyState ? (
          <Paper sx={{ p: 3, mb: 2 }}>
            <Typography
              color={emptyState.kind === "error" ? "error" : "text.secondary"}
              data-empty-kind={emptyState.kind}
            >
              {emptyState.message}
            </Typography>
          </Paper>
        ) : (
          <>
            <Stack
              spacing={1.5}
              sx={{ display: { xs: "flex", md: "none" }, mb: 2 }}
            >
              {visibleWallets.map((wallet) => (
                <Card key={wallet.address}>
                  <CardContent sx={{ "&:last-child": { pb: 2 } }}>
                    <WalletFields wallet={wallet} />
                  </CardContent>
                </Card>
              ))}
            </Stack>

            <Paper sx={{ display: { xs: "none", md: "block" } }}>
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
                  {visibleWallets.map((wallet) => (
                    <TableRow key={wallet.address} hover>
                      <TableCell sx={wrappingSx}>
                        <Link
                          component={NextLink}
                          href={`/address/${encodeURIComponent(wallet.address)}`}
                        >
                          {wallet.address}
                        </Link>
                      </TableCell>
                      <TableCell>{wallet.hops}</TableCell>
                      <TableCell sx={wrappingSx}>
                        {wallet.parent || "Not available"}
                      </TableCell>
                      <TableCell sx={wrappingSx}>
                        {wallet.origin || "Not available"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          </>
        )}

        <Box sx={{ mt: 2, display: "flex", justifyContent: "center" }}>
          {showLoadMore ? (
            <Button
              variant="outlined"
              disabled={session.loading}
              onClick={handleLoadMore}
              sx={{ ...touchButtonSx, minWidth: 160 }}
            >
              {session.loading ? "Loading..." : "Load more"}
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {session.loading
                ? "Loading..."
                : `${session.wallets.length.toLocaleString()} wallets loaded`}
            </Typography>
          )}
        </Box>
      </Container>
    </>
  );
}
