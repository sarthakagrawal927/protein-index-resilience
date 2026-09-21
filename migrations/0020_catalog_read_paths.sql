-- Catalog list pagination reads ~100k rows per query because every active
-- product probes the evidence-join fan-out before the ORDER BY/LIMIT applies.
-- Page selection now runs against `products` alone (plus only the joins the
-- active filter or sort reads); these indexes let the name and completeness
-- orderings stream off the index and stop at LIMIT instead of sorting the
-- whole catalog through a temp b-tree.
CREATE INDEX IF NOT EXISTS idx_products_active_name
  ON products(is_active, name_normalized, brand_normalized);

CREATE INDEX IF NOT EXISTS idx_products_active_completeness
  ON products(is_active, completeness DESC, name_normalized);
