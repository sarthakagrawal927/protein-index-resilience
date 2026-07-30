import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports.default;

describe("public indexing worker routes", () => {
  it("keeps catalog, sitemap, HTML, and markdown on the same active inventory", async () => {
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM products WHERE is_active = 1",
    ).first<{ count: number }>();
    const activeCount = Number(countRow?.count ?? 0);
    const first = await env.DB.prepare(
      "SELECT id, name FROM products WHERE is_active = 1 ORDER BY id LIMIT 1",
    ).first<{ id: string; name: string }>();
    expect(first).toBeTruthy();
    if (!first) return;

    const catalogResponse = await worker.fetch("http://localhost/api/ai");
    const catalog = (await catalogResponse.json()) as {
      collections: Array<{ count: number }>;
    };
    expect(catalog.collections[0]?.count).toBe(activeCount);

    const sitemapResponse = await worker.fetch("http://localhost/sitemap.xml");
    const sitemap = await sitemapResponse.text();
    expect(sitemapResponse.headers.get("content-type")).toContain("application/xml");
    expect(sitemap).toContain("/sitemaps/static.xml");
    expect(sitemap).toContain("/sitemaps/products-1.xml");

    const shard = await (
      await worker.fetch("http://localhost/sitemaps/products-1.xml")
    ).text();
    const productUrl = `http://localhost/products/${encodeURIComponent(first.id)}`;
    expect(shard).toContain(productUrl);

    const htmlResponse = await worker.fetch(productUrl);
    const markdownResponse = await worker.fetch(`${productUrl}.md`);
    const html = await htmlResponse.text();
    const markdown = await markdownResponse.text();
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(markdownResponse.headers.get("content-type")).toContain("text/markdown");
    expect(html).toContain(`rel="canonical" href="${productUrl}"`);
    expect(html).toContain(first.name.replaceAll("&", "&amp;"));
    expect(markdown).toContain(`**Canonical URL:** ${productUrl}`);
    expect(markdown).toContain(first.name);
  });

  it("returns no indexable representation for unknown products", async () => {
    const html = await worker.fetch("http://localhost/products/not-a-product");
    const markdown = await worker.fetch(
      "http://localhost/products/not-a-product.md",
    );
    expect(html.status).toBe(404);
    expect(await html.text()).toContain('content="noindex"');
    expect(markdown.status).toBe(404);
  });
});
