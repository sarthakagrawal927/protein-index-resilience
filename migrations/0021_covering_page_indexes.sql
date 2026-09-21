-- Extend the 0020 page-selection indexes to cover `id` and `completeness`.
-- `products.id` is a TEXT primary key, so it is not the rowid: without it the
-- planner must probe the table row for every index entry it walks (~2 reads
-- per product). With the result column and residual predicate carried in the
-- index, ORDER BY ... LIMIT scans stop after pageSize entries.
DROP INDEX IF EXISTS idx_products_active_name;
DROP INDEX IF EXISTS idx_products_active_completeness;

CREATE INDEX idx_products_active_name
  ON products(is_active, name_normalized, brand_normalized, completeness, id);

CREATE INDEX idx_products_active_completeness
  ON products(is_active, completeness DESC, name_normalized, id);
