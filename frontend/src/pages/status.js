import { useState, useEffect } from "react";
import {
  Container,
  Box,
  Typography,
  Paper,
  Grid,
  LinearProgress,
  Chip,
  Divider,
  Link,
} from "@mui/material";
import NextLink from "next/link";
import SEO from "../components/SEO";

const REFRESH_INTERVAL = 5;

export default function Status() {
  const [syncStatus, setSyncStatus] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  useEffect(() => {
    const fetchSyncStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/api/sync-status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json();
          setSyncStatus(data);
          setError(null);
          setLastUpdate(new Date());
          setCountdown(REFRESH_INTERVAL);
        } else {
          setError("Failed to fetch sync status");
        }
      } catch (err) {
        setError("Unable to connect to the backend service");
      }
    };

    fetchSyncStatus();
    const fetchInterval = setInterval(fetchSyncStatus, REFRESH_INTERVAL * 1000);
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => (prev > 1 ? prev - 1 : REFRESH_INTERVAL));
    }, 1000);

    return () => {
      clearInterval(fetchInterval);
      clearInterval(countdownInterval);
    };
  }, [API_URL]);

  const formatNumber = (num) => {
    return num?.toLocaleString() ?? "...";
  };

  const formatDate = (dateString) => {
    if (!dateString) return "Never";
    const date = new Date(dateString);
    const pad = (n) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}, ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const getProgressValue = (progress) => {
    if (!progress) return 0;
    return parseFloat(progress.replace("%", ""));
  };

  const isInitializing = (status) => {
    return status && status.isRunning && status.lastProcessedBlock === null;
  };

  const getStatusColor = (status) => {
    if (!status) return "default";
    if (isInitializing(status)) return "warning";
    if (status.blocksBehind === 0) return "success";
    if (status.blocksBehind < 100) return "info";
    if (status.blocksBehind < 1000) return "warning";
    return "error";
  };

  const getStatusLabel = (status) => {
    if (!status) return "Unknown";
    if (isInitializing(status)) return "Initializing";
    if (status.isSyncing) return "Syncing";
    if (status.blocksBehind === 0) return "Fully Synced";
    if (status.blocksBehind < 100) return "Almost Synced";
    return "Syncing";
  };

  return (
    <>
      <SEO
        title="Sync Status"
        description="Real-time blockchain synchronization status. Monitor the progress of scanning transactions connected to Satoshi's wallets."
        path="/status"
      />

      <Container maxWidth="md" sx={{ py: 6 }}>
        <Box sx={{ mb: 4 }}>
          <Link
            component={NextLink}
            href="/"
            underline="hover"
            color="text.secondary"
          >
            &larr; Back to search
          </Link>
        </Box>

        <Typography variant="h4" component="h1" gutterBottom>
          Synchronization Status
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          Scanning the blockchain for transactions connected to Satoshi{"'"}s wallets
        </Typography>

        {error ? (
          <Paper sx={{ p: 3, bgcolor: "error.dark" }}>
            <Typography color="error.contrastText">{error}</Typography>
          </Paper>
        ) : !syncStatus ? (
          <Paper sx={{ p: 3 }}>
            <Typography>Loading...</Typography>
            <LinearProgress sx={{ mt: 2 }} />
          </Paper>
        ) : (
          <Grid container spacing={3}>
            <Grid size={12}>
              <Paper sx={{ p: 3 }}>
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    mb: 2,
                  }}
                >
                  <Typography variant="h6">Progress</Typography>
                  <Chip
                    label={getStatusLabel(syncStatus)}
                    color={getStatusColor(syncStatus)}
                    size="small"
                  />
                </Box>
                <Box sx={{ mb: 2 }}>
                  {isInitializing(syncStatus) ? (
                    <LinearProgress sx={{ height: 10, borderRadius: 5 }} />
                  ) : (
                    <LinearProgress
                      variant="determinate"
                      value={getProgressValue(syncStatus.progress)}
                      sx={{ height: 10, borderRadius: 5 }}
                    />
                  )}
                </Box>
                <Typography variant="h5" align="center">
                  {isInitializing(syncStatus)
                    ? "Initializing..."
                    : syncStatus.progress ?? "..."}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  align="center"
                >
                  {isInitializing(syncStatus)
                    ? "Reading local database..."
                    : `Block ${formatNumber(syncStatus.lastProcessedBlock)} of ${formatNumber(syncStatus.currentHeight)}`}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  gutterBottom
                >
                  Last Processed Block
                </Typography>
                <Typography variant="h4">
                  {formatNumber(syncStatus.lastProcessedBlock)}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  gutterBottom
                >
                  Current Blockchain Height
                </Typography>
                <Typography variant="h4">
                  {formatNumber(syncStatus.currentHeight)}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  gutterBottom
                >
                  Blocks Behind
                </Typography>
                <Typography variant="h4">
                  {formatNumber(syncStatus.blocksBehind)}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  gutterBottom
                >
                  Service Status
                </Typography>
                <Typography variant="h4">
                  {syncStatus.isRunning ? "Running" : "Stopped"}
                </Typography>
              </Paper>
            </Grid>

            {syncStatus.stats && (
              <Grid size={12}>
                <Paper sx={{ p: 3 }}>
                  <Typography variant="h6" gutterBottom>
                    Statistics
                  </Typography>
                  <Divider sx={{ mb: 2 }} />
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Last Sync Time
                      </Typography>
                      <Typography>
                        {formatDate(syncStatus.stats.lastSyncTime)}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Blocks Processed
                      </Typography>
                      <Typography>
                        {formatNumber(syncStatus.stats.blocksProcessed)}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Addresses Updated
                      </Typography>
                      <Typography>
                        {formatNumber(syncStatus.stats.addressesUpdated)}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Errors
                      </Typography>
                      <Typography>{syncStatus.stats.errors ?? 0}</Typography>
                    </Grid>
                  </Grid>
                </Paper>
              </Grid>
            )}

            {syncStatus.config && (
              <Grid size={12}>
                <Paper sx={{ p: 3 }}>
                  <Typography variant="h6" gutterBottom>
                    Configuration
                  </Typography>
                  <Divider sx={{ mb: 2 }} />
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Sync Interval
                      </Typography>
                      <Typography>
                        {syncStatus.config.syncInterval / 1000}s
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Batch Size
                      </Typography>
                      <Typography>{syncStatus.config.batchSize}</Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Chunk Size
                      </Typography>
                      <Typography>{syncStatus.config.chunkSize}</Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                      <Typography
                        variant="subtitle2"
                        color="text.secondary"
                        gutterBottom
                      >
                        Enabled
                      </Typography>
                      <Chip
                        label={syncStatus.config.enabled ? "Yes" : "No"}
                        color={syncStatus.config.enabled ? "success" : "error"}
                        size="small"
                      />
                    </Grid>
                  </Grid>
                </Paper>
              </Grid>
            )}

            <Grid size={12}>
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  Refreshes in {countdown} second{countdown !== 1 ? "s" : ""}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Last updated: {lastUpdate ? formatDate(lastUpdate.toISOString()).split(", ")[1] : "..."}
                </Typography>
              </Box>
            </Grid>
          </Grid>
        )}
      </Container>
    </>
  );
}
