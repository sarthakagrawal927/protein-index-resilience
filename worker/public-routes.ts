export const PUBLIC_ORIGIN = "https://protein.significanthobbies.com";
export const PRODUCT_SITEMAP_PAGE_SIZE = 5_000;

export function productPath(id: string): string {
  return `/products/${encodeURIComponent(id)}`;
}

export function productMarkdownPath(id: string): string {
  return `${productPath(id)}.md`;
}

export function productSitemapPath(page: number): string {
  return `/sitemaps/products-${page}.xml`;
}

export function absoluteUrl(path: string, origin = PUBLIC_ORIGIN): string {
  return new URL(path, `${origin}/`).toString();
}

export function routeTemplateUrl(path: string, origin = PUBLIC_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

export async function countActiveProducts(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM products WHERE is_active = 1")
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function listActiveProductIds(
  db: D1Database,
  page: number,
  pageSize = PRODUCT_SITEMAP_PAGE_SIZE,
): Promise<string[]> {
  const offset = (page - 1) * pageSize;
  const result = await db
    .prepare(
      "SELECT id FROM products WHERE is_active = 1 ORDER BY id LIMIT ? OFFSET ?",
    )
    .bind(pageSize, offset)
    .all<{ id: string }>();
  return result.results.map(({ id }) => id);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

export function buildSitemapIndex(
  activeProductCount: number,
  origin = PUBLIC_ORIGIN,
): string {
  const shardCount = Math.ceil(activeProductCount / PRODUCT_SITEMAP_PAGE_SIZE);
  const locations = [
    absoluteUrl("/sitemaps/static.xml", origin),
    ...Array.from({ length: shardCount }, (_, index) =>
      absoluteUrl(productSitemapPath(index + 1), origin)),
  ];
  return xmlDocument(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations
      .map((location) => `  <sitemap><loc>${escapeXml(location)}</loc></sitemap>`)
      .join("\n")}\n</sitemapindex>`,
  );
}

export function buildStaticSitemap(origin = PUBLIC_ORIGIN): string {
  return buildUrlSet([absoluteUrl("/", origin)]);
}

export function buildProductSitemap(
  productIds: string[],
  origin = PUBLIC_ORIGIN,
): string {
  return buildUrlSet(productIds.map((id) => absoluteUrl(productPath(id), origin)));
}

function buildUrlSet(locations: string[]): string {
  return xmlDocument(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations
      .map((location) => `  <url><loc>${escapeXml(location)}</loc></url>`)
      .join("\n")}\n</urlset>`,
  );
}
