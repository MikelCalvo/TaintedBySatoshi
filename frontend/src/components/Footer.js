import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import GitHubIcon from "@mui/icons-material/GitHub";
import BitcoinIcon from "@mui/icons-material/CurrencyBitcoin";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SyncIcon from "@mui/icons-material/Sync";
import BarChartIcon from "@mui/icons-material/BarChart";
import Modal from "@mui/material/Modal";
import { useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Slide from "@mui/material/Slide";
import CheckIcon from "@mui/icons-material/Check";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import FlashOnIcon from "@mui/icons-material/FlashOn";
import NextLink from "next/link";

export function Footer() {
  const [showQR, setShowQR] = useState(false);
  const [tabValue, setTabValue] = useState(0);
  const [copyTooltip, setCopyTooltip] = useState("Copy to clipboard");
  const [showAlert, setShowAlert] = useState(false);
  const donationAddress = process.env.NEXT_PUBLIC_DONATION_ADDRESS;
  const lightningAddress = process.env.NEXT_PUBLIC_LIGHTNING_ADDRESS;
  const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL;

  const handleDonateClick = useCallback((e) => {
    e.preventDefault();
    setShowQR(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowQR(false);
    setCopyTooltip("Copy to clipboard");
  }, []);

  const handleTabChange = useCallback((event, newValue) => {
    setTabValue(newValue);
    setCopyTooltip("Copy to clipboard");
  }, []);

  const handleCopyClick = useCallback(async () => {
    try {
      const addressToCopy = tabValue === 0 ? donationAddress : lightningAddress;
      await navigator.clipboard.writeText(addressToCopy);
      setShowAlert(true);
      setTimeout(() => {
        setShowAlert(false);
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      setCopyTooltip("Failed to copy");
    }
  }, [donationAddress, lightningAddress, tabValue]);

  return (
    <>
      <Box
        component="footer"
        sx={{
          py: 3,
          px: 2,
          mt: "auto",
          backgroundColor: "background.default",
          borderTop: "1px solid",
          borderColor: "primary.main",
          position: "relative",
          "&::before": {
            content: '""',
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "1px",
            background: (theme) =>
              `linear-gradient(90deg, transparent, ${theme.palette.primary.main}, transparent)`,
            boxShadow: (theme) => `0 0 10px ${theme.palette.primary.main}`,
          },
        }}
      >
        <Box
          sx={{
            textAlign: "center",
            color: "text.secondary",
            "& .MuiLink-root": {
              transition: "all 0.2s ease-in-out",
              "&:hover": {
                color: "primary.main",
                textShadow: (theme) => `0 0 8px ${theme.palette.primary.main}`,
              },
            },
          }}
        >
          {/* First line: Sync Status and Analytics */}
          <Typography variant="body2" sx={{ mb: 0.5 }}>
            <Link
              component={NextLink}
              href="/status"
              color="primary"
              underline="none"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
              }}
            >
              <SyncIcon sx={{ fontSize: "inherit" }} />
              Sync Status
            </Link>
            {" • "}
            <Link
              component={NextLink}
              href="/stats"
              color="primary"
              underline="none"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
              }}
            >
              <BarChartIcon sx={{ fontSize: "inherit" }} />
              Analytics
            </Link>
          </Typography>

          {/* Second line: Made by, Source Code, Donate */}
          <Typography variant="body2">
            Made by{" "}
            <Link
              href="https://mikelcalvo.net"
              target="_blank"
              rel="noopener noreferrer"
              color="primary"
              underline="none"
            >
              Mikel Calvo
            </Link>
            {repositoryUrl && (
              <>
                {" • "}
                <Link
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  color="primary"
                  underline="none"
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  <GitHubIcon sx={{ fontSize: "inherit" }} />
                  Source Code
                </Link>
              </>
            )}
            {(donationAddress || lightningAddress) && (
              <>
                {" • "}
                <Link
                  href="#"
                  color="primary"
                  underline="none"
                  onClick={handleDonateClick}
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.5,
                    cursor: "pointer",
                  }}
                >
                  <BitcoinIcon sx={{ fontSize: "inherit" }} />
                  Donate
                </Link>
              </>
            )}
          </Typography>
        </Box>
      </Box>

      <Modal
        open={showQR}
        onClose={handleCloseModal}
        aria-labelledby="donation-qr-modal"
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        disablePortal={false}
      >
        <Box
          onClick={(e) => e.stopPropagation()}
          sx={{
            bgcolor: "background.paper",
            boxShadow: 24,
            p: 4,
            borderRadius: 2,
            textAlign: "center",
            maxWidth: "90vw",
            outline: "none",
          }}
        >
          <Typography variant="h6" component="h2" gutterBottom>
            Donation
          </Typography>

          {donationAddress && lightningAddress && (
            <Tabs
              value={tabValue}
              onChange={handleTabChange}
              centered
              sx={{
                mb: 3,
                "& .MuiTab-root": {
                  color: "text.secondary",
                  "&.Mui-selected": {
                    color: "primary.main",
                  },
                },
                "& .MuiTabs-indicator": {
                  backgroundColor: "primary.main",
                },
              }}
            >
              <Tab
                icon={<BitcoinIcon />}
                label="Bitcoin"
                iconPosition="start"
              />
              <Tab
                icon={<FlashOnIcon />}
                label="Lightning"
                iconPosition="start"
              />
            </Tabs>
          )}

          {donationAddress && !lightningAddress && (
            <Typography variant="subtitle1" gutterBottom sx={{ color: "primary.main", mb: 2 }}>
              Bitcoin On-Chain
            </Typography>
          )}

          {!donationAddress && lightningAddress && (
            <Typography variant="subtitle1" gutterBottom sx={{ color: "primary.main", mb: 2 }}>
              Lightning Network
            </Typography>
          )}

          {donationAddress && (tabValue === 0 || !lightningAddress) && (
            <>
              <Box
                sx={{
                  bgcolor: "white",
                  p: 2,
                  borderRadius: 1,
                  display: "inline-block",
                  mb: 2,
                }}
              >
                <QRCodeSVG
                  value={`bitcoin:${donationAddress}`}
                  size={256}
                  level="H"
                  includeMargin={true}
                />
              </Box>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1,
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    wordBreak: "break-all",
                    fontFamily: "monospace",
                    bgcolor: "background.default",
                    p: 2,
                    borderRadius: 1,
                    flex: 1,
                  }}
                >
                  {donationAddress}
                </Typography>
                <Tooltip title={copyTooltip}>
                  <IconButton
                    onClick={handleCopyClick}
                    size="small"
                    sx={{
                      color: "primary.main",
                      "&:hover": {
                        color: "primary.light",
                        "& svg": {
                          filter: (theme) =>
                            `drop-shadow(0 0 2px ${theme.palette.primary.main})`,
                        },
                      },
                    }}
                  >
                    <ContentCopyIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </>
          )}

          {lightningAddress && (tabValue === 1 || !donationAddress) && (
            <>
              <Box
                sx={{
                  bgcolor: "white",
                  p: 2,
                  borderRadius: 1,
                  display: "inline-block",
                  mb: 2,
                }}
              >
                <QRCodeSVG
                  value={`lightning:${lightningAddress}`}
                  size={256}
                  level="H"
                  includeMargin={true}
                />
              </Box>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1,
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    wordBreak: "break-all",
                    fontFamily: "monospace",
                    bgcolor: "background.default",
                    p: 2,
                    borderRadius: 1,
                    flex: 1,
                  }}
                >
                  {lightningAddress}
                </Typography>
                <Tooltip title={copyTooltip}>
                  <IconButton
                    onClick={handleCopyClick}
                    size="small"
                    sx={{
                      color: "primary.main",
                      "&:hover": {
                        color: "primary.light",
                        "& svg": {
                          filter: (theme) =>
                            `drop-shadow(0 0 2px ${theme.palette.primary.main})`,
                        },
                      },
                    }}
                  >
                    <ContentCopyIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </>
          )}
        </Box>
      </Modal>

      <Slide direction="down" in={showAlert} mountOnEnter unmountOnExit>
        <Box
          sx={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            minWidth: 200,
            backgroundColor: "background.paper",
            border: "1px solid",
            borderColor: "primary.main",
            borderRadius: 1,
            p: 1.5,
            display: "flex",
            alignItems: "center",
            gap: 1,
            boxShadow: (theme) => `0 0 10px ${theme.palette.primary.main}`,
            animation: "glow 1.5s ease-in-out infinite alternate",
            "@keyframes glow": {
              "0%": {
                boxShadow: (theme) => `0 0 5px ${theme.palette.primary.main}`,
              },
              "100%": {
                boxShadow: (theme) => `0 0 20px ${theme.palette.primary.main}`,
              },
            },
          }}
        >
          <CheckIcon
            sx={{
              color: "primary.main",
              animation: "iconGlow 1.5s ease-in-out infinite alternate",
              "@keyframes iconGlow": {
                "0%": {
                  filter: (theme) =>
                    `drop-shadow(0 0 2px ${theme.palette.primary.main})`,
                },
                "100%": {
                  filter: (theme) =>
                    `drop-shadow(0 0 8px ${theme.palette.primary.main})`,
                },
              },
            }}
          />
          <Typography
            variant="body2"
            sx={{
              color: "text.primary",
              textShadow: (theme) => `0 0 8px ${theme.palette.primary.main}`,
            }}
          >
            Address copied!
          </Typography>
        </Box>
      </Slide>
    </>
  );
}
