import Head from "next/head";

const SITE_NAME = "Tainted By Satoshi";
const DEFAULT_DESCRIPTION =
  "Check if a Bitcoin address has any connection to Satoshi Nakamoto's wallets through transaction history";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://taintedbysatoshi.com";

export default function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  path = "",
  noindex = false,
}) {
  const fullTitle = title ? `${title} - ${SITE_NAME}` : SITE_NAME;
  const canonicalUrl = `${SITE_URL}${path}`;

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonicalUrl} />

      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:locale" content="en_US" />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
    </Head>
  );
}
