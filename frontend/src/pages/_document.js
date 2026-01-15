import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta charSet="utf-8" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta
          name="keywords"
          content="Bitcoin, Satoshi Nakamoto, taint analysis, blockchain, cryptocurrency, wallet tracker"
        />
        <meta name="author" content="TaintedBySatoshi" />

        {/* Structured Data - WebSite */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "Tainted By Satoshi",
              description:
                "Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets through transaction history",
              applicationCategory: "FinanceApplication",
              operatingSystem: "Any",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
            }),
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
