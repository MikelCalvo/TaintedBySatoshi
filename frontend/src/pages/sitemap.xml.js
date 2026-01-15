const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://taintedbysatoshi.com";

function generateSitemap() {
  const pages = [
    { path: "/", priority: "1.0", changefreq: "daily" },
    { path: "/status", priority: "0.5", changefreq: "hourly" },
    { path: "/stats", priority: "0.5", changefreq: "daily" },
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) => `  <url>
    <loc>${SITE_URL}${page.path}</loc>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;
}

export async function getServerSideProps({ res }) {
  const sitemap = generateSitemap();

  res.setHeader("Content-Type", "text/xml");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate");
  res.write(sitemap);
  res.end();

  return { props: {} };
}

export default function Sitemap() {
  return null;
}
