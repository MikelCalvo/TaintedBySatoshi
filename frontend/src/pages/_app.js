import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { CacheProvider } from "@emotion/react";
import createEmotionCache from "../lib/createEmotionCache";
import theme from "../styles/theme";
import { StyledEngineProvider } from "@mui/material/styles";
import Box from "@mui/material/Box";
import { Footer } from "../components/Footer";
import { TrackingProvider } from "../contexts/TrackingContext";

// Client-side cache, shared for the whole session of the user in the browser.
const clientSideEmotionCache = createEmotionCache();

export default function MyApp(props) {
  const { Component, emotionCache = clientSideEmotionCache, pageProps } = props;

  return (
    <CacheProvider value={emotionCache}>
      <StyledEngineProvider injectFirst>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <TrackingProvider>
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                minHeight: "100vh",
              }}
            >
              <Box sx={{ flex: "1 0 auto" }}>
                <Component {...pageProps} />
              </Box>
              <Footer />
            </Box>
          </TrackingProvider>
        </ThemeProvider>
      </StyledEngineProvider>
    </CacheProvider>
  );
}

// Remove getInitialProps if it exists
