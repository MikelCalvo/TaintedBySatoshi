import { useEffect, useReducer, useRef, useState } from "react";
import NextLink from "next/link";
import {
  Box,
  Button,
  Card,
  CardContent,
  Container,
  FormControl,
  InputLabel,
  LinearProgress,
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
  EMPTY_PAGE_AUTO_CONTINUE_MAX,
  SORT_OPTIONS,
  formatWalletsUpdatedAt,
  getEmptyState,
  getLoadMoreLabel,
  getMatchSummary,
  getScopeCopy,
  getVisibleWallets,
  isHopRangeValid,
  parseHopBound,
  shouldAutoContinueEmptyPage,
  shouldRefreshWalletsSnapshot,
  shouldShowLoadMore,
} from "../utils/walletsExplorer.mjs";
import {
  createInitialWalletsSession,
  createWalletsLoader,
  createWalletsRefreshScheduler,
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
  minHeight: 44,
  px: 2,
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

function loadApplied(loader, session, extras = {}) {
  if (!loader) return;
  loader.load({
    q: session.appliedQuery,
    sort: session.sort,
    minHops: session.minHops,
    maxHops: session.maxHops,
    apply: extras.apply,
    ...extras,
  });
}

export default function WalletsPage() {
  const [session, dispatch] = useReducer(
    reduceWalletsSession,
    null,
    createInitialWalletsSession
  );
  const [hopError, setHopError] = useState("");
  const loaderRef = useRef(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const loader = createWalletsLoader({ apiUrl: API_URL });
    loaderRef.current = loader;
    dispatch({ type: "reset" });
    loader.load({ sort: "address-asc", apply: dispatch });

    const scheduler = createWalletsRefreshScheduler({
      isVisible: () => document.visibilityState === "visible",
      getState: () => sessionRef.current,
      onRefresh: () => {
        const current = sessionRef.current;
        if (
          !shouldRefreshWalletsSnapshot({
            loading: current.loading,
            visible: document.visibilityState === "visible",
            mounted: true,
            indexBuilding: Boolean(current.indexBuilding),
          })
        ) {
          return;
        }
        dispatch({ type: "refresh-snapshot" });
        loadApplied(loader, current, { apply: dispatch });
      },
    });
    scheduler.start();

    return () => {
      scheduler.stop();
      loader.abort();
    };
  }, []);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader || session.loading) return;
    if (
      !shouldAutoContinueEmptyPage({
        walletsCount: session.wallets.length,
        nextCursor: session.nextCursor,
        autoContinues: session.autoContinues,
      })
    ) {
      return;
    }
    const cursor = session.nextCursor;
    dispatch({ type: "auto-continue" });
    loadApplied(loader, session, { cursor, append: true, apply: dispatch });
  }, [
    session.loading,
    session.wallets.length,
    session.nextCursor,
    session.autoContinues,
    session.appliedQuery,
    session.sort,
    session.minHops,
    session.maxHops,
  ]);

  const visibleWallets = getVisibleWallets(session.wallets);
  const emptyState = getEmptyState({
    loading: session.loading,
    error: session.error,
    loadedCount: session.wallets.length,
    matchCount: visibleWallets.length,
    query: session.appliedQuery,
    minHops: session.minHops,
    maxHops: session.maxHops,
    nextCursor: session.nextCursor,
    indexBuilding: session.indexBuilding,
  });
  const showLoadMore = shouldShowLoadMore({
    nextCursor: session.nextCursor,
    matchCount: visibleWallets.length,
    loading: session.loading,
  });
  const loadMoreLabel = getLoadMoreLabel({
    walletsCount: visibleWallets.length,
    autoContinuesExhausted: (session.autoContinues || 0) >= EMPTY_PAGE_AUTO_CONTINUE_MAX,
    loading: session.loading,
  });

  const parseDraftHops = () => {
    const minHops = parseHopBound(session.draftMinHops);
    const maxHops = parseHopBound(session.draftMaxHops);
    if (!isHopRangeValid(minHops, maxHops)) {
      setHopError("Hop range must use nonnegative whole numbers, with min ≤ max.");
      return null;
    }
    setHopError("");
    return { minHops, maxHops };
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const hops = parseDraftHops();
    if (!hops) return;
    const loader = loaderRef.current;
    if (!loader) return;
    dispatch({ type: "apply-hop-range", minHops: hops.minHops, maxHops: hops.maxHops });
    dispatch({ type: "submit-search", query: session.draftQuery });
    loader.load({
      q: session.draftQuery,
      sort: session.sort,
      minHops: hops.minHops,
      maxHops: hops.maxHops,
      apply: dispatch,
    });
  };

  const handleReset = () => {
    const loader = loaderRef.current;
    if (!loader) return;
    setHopError("");
    dispatch({ type: "reset" });
    loader.load({ sort: "address-asc", apply: dispatch });
  };

  const handleSort = (sort) => {
    const loader = loaderRef.current;
    if (!loader) return;
    dispatch({ type: "set-sort", sort });
    loader.load({
      q: session.appliedQuery,
      sort,
      minHops: session.minHops,
      maxHops: session.maxHops,
      apply: dispatch,
    });
  };

  const handleLoadMore = () => {
    const loader = loaderRef.current;
    if (!loader || !session.nextCursor) return;
    const cursor = session.nextCursor;
    dispatch({ type: "load-more" });
    loadApplied(loader, session, { cursor, append: true, apply: dispatch });
  };

  return (
    <>
      <SEO
        title="Tainted Wallets"
        description="Browse Bitcoin wallets connected to Satoshi Nakamoto and the hop count of each connection."
        path="/wallets"
      />
      <Container maxWidth="lg" sx={{ py: { xs: 1, md: 6 }, px: { xs: 2, sm: 3 } }}>
        <Link component={NextLink} href="/" underline="hover" color="text.secondary" variant="body2">
          &larr; Back to search
        </Link>
        <Typography
          variant="h4"
          sx={{
            mt: { xs: 0.5, md: 2 },
            mb: { xs: 0.25, md: 1 },
            fontSize: { xs: "1.75rem", md: undefined },
            lineHeight: { xs: 1.2, md: undefined },
          }}
        >
          Tainted wallets
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: { xs: 1, md: 3 } }}>
          Wallets connected to Patoshi/Satoshi coinbase outputs.
        </Typography>

        <Paper
          component="form"
          onSubmit={handleSubmit}
          sx={{ p: { xs: 1, sm: 3 }, mb: { xs: 1, md: 3 } }}
        >
          <Stack spacing={{ xs: 1, sm: 2 }}>
            <TextField
              fullWidth
              size="small"
              label="Address prefix"
              placeholder="Case-sensitive address or prefix"
              value={session.draftQuery}
              onChange={(event) =>
                dispatch({ type: "set-draft-query", query: event.target.value })
              }
              sx={{ "& .MuiInputBase-root": { minHeight: 44 } }}
              slotProps={{
                htmlInput: {
                  "aria-label": "Address prefix",
                  autoComplete: "off",
                },
              }}
            />
            <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 1, sm: 2 }}>
              <FormControl fullWidth size="small">
                <InputLabel id="wallets-sort-label">Sort</InputLabel>
                <Select
                  labelId="wallets-sort-label"
                  label="Sort"
                  value={session.sort}
                  onChange={(event) => handleSort(event.target.value)}
                  sx={{ minHeight: 44 }}
                >
                  {SORT_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: { md: "flex-start" } }}>
              <TextField
                size="small"
                label="Min hops"
                value={session.draftMinHops}
                onChange={(event) => {
                  dispatch({
                    type: "set-draft-hops",
                    minHops: event.target.value,
                    maxHops: session.draftMaxHops,
                  });
                }}
                sx={{ flex: 1, minWidth: 0, "& .MuiInputBase-root": { minHeight: 44 } }}
                slotProps={{
                  htmlInput: {
                    inputMode: "numeric",
                    "aria-label": "Minimum hops",
                  },
                }}
                error={Boolean(hopError)}
              />
              <TextField
                size="small"
                label="Max hops"
                value={session.draftMaxHops}
                onChange={(event) => {
                  dispatch({
                    type: "set-draft-hops",
                    minHops: session.draftMinHops,
                    maxHops: event.target.value,
                  });
                }}
                sx={{ flex: 1, minWidth: 0, "& .MuiInputBase-root": { minHeight: 44 } }}
                slotProps={{
                  htmlInput: {
                    inputMode: "numeric",
                    "aria-label": "Maximum hops",
                  },
                }}
                error={Boolean(hopError)}
                helperText={hopError}
              />
            </Stack>
            <Stack
              direction={{ xs: "row", sm: "row" }}
              spacing={1}
              sx={{ justifyContent: "flex-end" }}
            >
              <Button
                type="button"
                variant="outlined"
                onClick={handleReset}
                sx={{ ...touchButtonSx, flex: 1, minWidth: 0, minHeight: 44 }}
              >
                Reset
              </Button>
              <Button
                type="submit"
                variant="contained"
                sx={{ ...touchButtonSx, flex: 1, minWidth: 0, minHeight: 44 }}
              >
                Search
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3, display: "block" }}>
              {getScopeCopy()}{" "}
              {getMatchSummary({
                matchCount: visibleWallets.length,
                scanned: session.scanned,
              })}
              {session.updatedAt ? ` · ${formatWalletsUpdatedAt(session.updatedAt)}` : ""}
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
            {emptyState.kind === "index-building" && (
              <Box sx={{ mt: 2 }}>
                <LinearProgress />
                {session.indexBuilding?.indexed != null && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                    {session.indexBuilding.indexed}
                    {session.indexBuilding.total != null
                      ? ` / ${session.indexBuilding.total}`
                      : ""}
                    {session.indexBuilding.phase ? ` · ${session.indexBuilding.phase}` : ""}
                  </Typography>
                )}
              </Box>
            )}
          </Paper>
        ) : (
          <>
            <Stack
              spacing={1.5}
              sx={{ display: { xs: "flex", md: "none" }, mb: { xs: 1, md: 2 } }}
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
              {loadMoreLabel}
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
