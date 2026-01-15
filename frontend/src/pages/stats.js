import { useState, useEffect } from "react";
import Head from "next/head";
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import NextLink from "next/link";
import VisibilityIcon from "@mui/icons-material/Visibility";
import PeopleIcon from "@mui/icons-material/People";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import LanguageIcon from "@mui/icons-material/Language";

const REFRESH_INTERVAL = 30;

const TIME_RANGES = [
  { value: 1, label: "24h" },
  { value: 7, label: "7d" },
  { value: 15, label: "15d" },
  { value: 30, label: "30d" },
  { value: 365, label: "365d" },
  { value: 36500, label: "All" }, // ~100 years = effectively all
];

export default function Stats() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [selectedRange, setSelectedRange] = useState(30);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const handleRangeChange = (event, newRange) => {
    if (newRange !== null) {
      setSelectedRange(newRange);
      setLoading(true);
    }
  };

  const getRangeLabel = () => {
    const range = TIME_RANGES.find((r) => r.value === selectedRange);
    return range ? range.label : `${selectedRange}d`;
  };

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/analytics/stats?days=${selectedRange}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (response.ok) {
          const data = await response.json();
          if (data.enabled === false) {
            setError("Analytics is currently disabled");
          } else {
            setStats(data);
            setError(null);
          }
        } else {
          setError("Failed to fetch analytics");
        }
      } catch (err) {
        setError("Unable to connect to analytics service");
      } finally {
        setLoading(false);
        setCountdown(REFRESH_INTERVAL);
      }
    };

    fetchStats();
    const fetchInterval = setInterval(fetchStats, REFRESH_INTERVAL * 1000);
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => (prev > 1 ? prev - 1 : REFRESH_INTERVAL));
    }, 1000);

    return () => {
      clearInterval(fetchInterval);
      clearInterval(countdownInterval);
    };
  }, [API_URL, selectedRange]);

  const formatNumber = (num) => {
    return num?.toLocaleString() ?? "0";
  };

  const truncatePath = (path, maxLength = 40) => {
    if (!path) return "/";
    return path.length > maxLength ? path.slice(0, maxLength) + "..." : path;
  };

  return (
    <>
      <Head>
        <title>Analytics - Tainted By Satoshi</title>
        <meta name="description" content="Public analytics and statistics" />
      </Head>

      <Container maxWidth="lg" sx={{ py: 6 }}>
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
          Public Analytics
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Open source, privacy-respecting analytics for this project
        </Typography>

        {/* Time Range Selector */}
        <Box sx={{ mb: 4 }}>
          <ToggleButtonGroup
            value={selectedRange}
            exclusive
            onChange={handleRangeChange}
            size="small"
            sx={{
              "& .MuiToggleButton-root": {
                color: "text.secondary",
                borderColor: "divider",
                "&.Mui-selected": {
                  color: "primary.main",
                  bgcolor: "rgba(5, 217, 232, 0.1)",
                  borderColor: "primary.main",
                  "&:hover": {
                    bgcolor: "rgba(5, 217, 232, 0.2)",
                  },
                },
                "&:hover": {
                  bgcolor: "rgba(255, 255, 255, 0.05)",
                },
              },
            }}
          >
            {TIME_RANGES.map((range) => (
              <ToggleButton key={range.value} value={range.value}>
                {range.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        {error ? (
          <Paper sx={{ p: 3, bgcolor: "error.dark" }}>
            <Typography color="error.contrastText">{error}</Typography>
          </Paper>
        ) : loading ? (
          <Paper sx={{ p: 3 }}>
            <Typography>Loading analytics...</Typography>
            <LinearProgress sx={{ mt: 2 }} />
          </Paper>
        ) : (
          <Grid container spacing={3}>
            {/* Summary Cards */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}
                >
                  <VisibilityIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary">
                    Page Views ({getRangeLabel()})
                  </Typography>
                </Box>
                <Typography variant="h4">
                  {formatNumber(stats?.summary?.totalPageViews)}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}
                >
                  <PeopleIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary">
                    Unique Visitors
                  </Typography>
                </Box>
                <Typography variant="h4">
                  {formatNumber(stats?.summary?.uniqueVisitors)}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}
                >
                  <TrendingUpIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary">
                    Avg. Daily Views
                  </Typography>
                </Box>
                <Typography variant="h4">
                  {formatNumber(
                    Math.round((stats?.summary?.totalPageViews || 0) / selectedRange)
                  )}
                </Typography>
              </Paper>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}
                >
                  <LanguageIcon color="primary" />
                  <Typography variant="subtitle2" color="text.secondary">
                    Traffic Sources
                  </Typography>
                </Box>
                <Typography variant="h4">
                  {stats?.topReferrers?.length || 0}
                </Typography>
              </Paper>
            </Grid>

            {/* Top Pages */}
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography variant="h6" gutterBottom>
                  Top Pages
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {stats?.topPages?.length > 0 ? (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Page</TableCell>
                          <TableCell align="right">Views</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {stats.topPages.slice(0, 10).map((page, index) => (
                          <TableRow key={index}>
                            <TableCell
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.85rem",
                              }}
                            >
                              <Link
                                component={NextLink}
                                href={page.path}
                                sx={{
                                  color: "inherit",
                                  textDecoration: "none",
                                  "&:hover": {
                                    textDecoration: "underline",
                                  },
                                }}
                              >
                                {truncatePath(page.path)}
                              </Link>
                            </TableCell>
                            <TableCell align="right">
                              {formatNumber(page.views)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                ) : (
                  <Typography color="text.secondary">No data yet</Typography>
                )}
              </Paper>
            </Grid>

            {/* Top Referrers */}
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 3, height: "100%" }}>
                <Typography variant="h6" gutterBottom>
                  Traffic Sources
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {stats?.topReferrers?.length > 0 ? (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Source</TableCell>
                          <TableCell align="right">Visits</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {stats.topReferrers.slice(0, 10).map((ref, index) => (
                          <TableRow key={index}>
                            <TableCell>
                              <Chip
                                label={ref.source}
                                size="small"
                                variant="outlined"
                                color={
                                  ref.source === "direct" ? "primary" : "default"
                                }
                              />
                            </TableCell>
                            <TableCell align="right">
                              {formatNumber(ref.count)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                ) : (
                  <Typography color="text.secondary">No data yet</Typography>
                )}
              </Paper>
            </Grid>

            {/* Device Types */}
            <Grid size={12}>
              <Paper sx={{ p: 3 }}>
                <Typography variant="h6" gutterBottom>
                  Visitor Devices
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {stats?.userAgents &&
                Object.keys(stats.userAgents).length > 0 ? (
                  <Grid container spacing={2}>
                    {Object.entries(stats.userAgents).map(([type, count]) => (
                      <Grid size={{ xs: 6, sm: 3 }} key={type}>
                        <Paper
                          sx={{
                            p: 2,
                            textAlign: "center",
                            bgcolor: "background.default",
                          }}
                        >
                          <Typography variant="h5">
                            {formatNumber(count)}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ textTransform: "capitalize" }}
                          >
                            {type}
                          </Typography>
                        </Paper>
                      </Grid>
                    ))}
                  </Grid>
                ) : (
                  <Typography color="text.secondary">No data yet</Typography>
                )}
              </Paper>
            </Grid>

            {/* Refresh indicator */}
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
                <Chip
                  label="Privacy-first: No personal data collected"
                  size="small"
                  color="success"
                  variant="outlined"
                />
              </Box>
            </Grid>
          </Grid>
        )}
      </Container>
    </>
  );
}
