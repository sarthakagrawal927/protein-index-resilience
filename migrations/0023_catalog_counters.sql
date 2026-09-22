-- Catalog totals for the unfiltered browse path.
--
-- D1 bills rows examined, and COUNT(*) WHERE is_active = 1 must walk every
-- matching index entry (~19k reads) — that was the entire remaining cost of
-- an uncached default /api/products request after the 0020–0022 page/index
-- work. The unfiltered total only changes when a product's is_active flag
-- flips, so a trigger-maintained counter serves it in ~1 read. Filtered
-- queries still run a real COUNT over their narrower predicate set.

CREATE TABLE catalog_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT INTO catalog_counters (name, value)
  SELECT 'active_products', COUNT(*) FROM products WHERE is_active = 1;

CREATE TRIGGER catalog_counters_products_insert AFTER INSERT ON products BEGIN
  UPDATE catalog_counters
    SET value = value + NEW.is_active
  WHERE name = 'active_products';
END;

CREATE TRIGGER catalog_counters_products_delete AFTER DELETE ON products BEGIN
  UPDATE catalog_counters
    SET value = value - OLD.is_active
  WHERE name = 'active_products';
END;

-- Scoped to is_active writes only; the density-key trigger's UPDATEs do not
-- re-fire this.
CREATE TRIGGER catalog_counters_products_update AFTER UPDATE OF is_active ON products BEGIN
  UPDATE catalog_counters
    SET value = value + NEW.is_active - OLD.is_active
  WHERE name = 'active_products';
END;
