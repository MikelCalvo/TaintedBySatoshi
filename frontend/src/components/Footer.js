import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import GitHubIcon from "@mui/icons-material/GitHub";
import BitcoinIcon from "@mui/icons-material/CurrencyBitcoin";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import Modal from "@mui/material/Modal";
import { useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Slide from "@mui/material/Slide";
import CheckIcon from "@mui/icons-material/Check";

export function Footer() {
  const [showQR, setShowQR] = useState(false);
  const [copyTooltip, setCopyTooltip] = useState("Copy to clipboard");
  const [showAlert, setShowAlert] = useState(false);
  const donationAddress = process.env.NEXT_PUBLIC_DONATION_ADDRESS;
  const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL;

  const handleDonateClick = useCallback((e) => {
    e.preventDefault();
    setShowQR(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowQR(false);
    setCopyTooltip("Copy to clipboard");
  }, []);

  const handleCopyClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(donationAddress);
      setShowAlert(true);
      setTimeout(() => {
        setShowAlert(false);
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      setCopyTooltip("Failed to copy");
    }
  }, [donationAddress]);

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
        <Typography
          variant="body2"
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
          {donationAddress && (
            <>
              {" • "}
              <Link
                href={`bitcoin:${donationAddress}`}
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
            Bitcoin Donation Address
          </Typography>
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
