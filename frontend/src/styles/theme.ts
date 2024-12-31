import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#05d9e8",
      light: "#d1f7ff",
      dark: "#005678",
    },
    secondary: {
      main: "#ff2a6d",
      light: "#ff5c8d",
      dark: "#c4004f",
    },
    background: {
      default: "#000005",
      paper: "#020236",
    },
    text: {
      primary: "#ffffff",
      secondary: "#d1f7ff",
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h1: {
      background: "linear-gradient(45deg, #05d9e8 30%, #ff2a6d 90%)",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      fontWeight: 700,
    },
    h2: {
      color: "#05d9e8",
    },
    h3: {
      color: "#05d9e8",
    },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 0,
          textTransform: "none",
          "&:hover": {
            boxShadow: "0 0 10px #05d9e8",
          },
        },
        contained: {
          background: "linear-gradient(45deg, #05d9e8 30%, #ff2a6d 90%)",
          color: "#ffffff",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: "#020236",
          borderRadius: 0,
          border: "1px solid #05d9e8",
          "&:hover": {
            boxShadow: "0 0 15px #05d9e8",
          },
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            "& fieldset": {
              borderColor: "#005678",
            },
            "&:hover fieldset": {
              borderColor: "#05d9e8",
            },
            "&.Mui-focused fieldset": {
              borderColor: "#05d9e8",
            },
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: "#6b6b6b #2b2b2b",
          "&::-webkit-scrollbar, & *::-webkit-scrollbar": {
            backgroundColor: "#2b2b2b",
          },
          "&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb": {
            borderRadius: 8,
            backgroundColor: "#6b6b6b",
            minHeight: 24,
            border: "3px solid #2b2b2b",
          },
          "&::-webkit-scrollbar-thumb:focus, & *::-webkit-scrollbar-thumb:focus":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover":
            {
              backgroundColor: "#959595",
            },
          "&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner": {
            backgroundColor: "#2b2b2b",
          },
        },
      },
    },
  },
});

export default theme;
