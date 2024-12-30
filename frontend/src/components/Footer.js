import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import GitHubIcon from '@mui/icons-material/GitHub';
import BitcoinIcon from '@mui/icons-material/CurrencyBitcoin';

export function Footer() {
  const donationAddress = process.env.NEXT_PUBLIC_DONATION_ADDRESS;
  const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL;

  return (
    <Box
      component="footer"
      sx={{
        py: 3,
        px: 2,
        mt: 'auto',
        backgroundColor: 'background.paper',
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        align="center"
      >
        Made by{' '}
        <Link
          href="https://mikelcalvo.net"
          target="_blank"
          rel="noopener noreferrer"
          color="primary"
          underline="hover"
        >
          Mikel Calvo
        </Link>
        {repositoryUrl && (
          <>
            {' • '}
            <Link
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              color="primary"
              underline="hover"
              sx={{ 
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5
              }}
            >
              <GitHubIcon sx={{ fontSize: 'inherit' }} />
              Source Code
            </Link>
          </>
        )}
        {donationAddress && (
          <>
            {' • '}
            <Link
              href={`bitcoin:${donationAddress}`}
              color="primary"
              underline="hover"
              sx={{ 
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5
              }}
            >
              <BitcoinIcon sx={{ fontSize: 'inherit' }} />
              Donate
            </Link>
          </>
        )}
      </Typography>
    </Box>
  );
} 