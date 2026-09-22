-- Denormalized sort key for the default protein-density ordering.
--
-- The catalog's protein_density ORDER BY is a computed expression over
-- nutrition_facts and the current verified/machine overlays. Evaluating it in
-- the page-selection query forced ~4 relation probes per product (~84k rows
-- read per request) because the sort could not stream off an index. Storing
-- the key on `products` lets page selection stream
-- idx_products_active_density and stop at LIMIT.
--
-- `product_density_sort_keys` is the single canonical definition of the key;
-- the column is maintained by triggers on every input relation so it stays
-- correct under local mutations, tests, and publication imports alike. The
-- catalog ORDER BY must not reintroduce the raw expression.

ALTER TABLE products ADD COLUMN sort_protein_density REAL;

CREATE VIEW product_density_sort_keys AS
SELECT p.id AS product_id,
  CASE
    WHEN (verified_nutrition.product_id IS NOT NULL
        OR machine_nutrition.product_id IS NOT NULL
        OR n.status IN ('verified', 'unverified'))
      AND COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories) > 0
      AND COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) >= 0
      AND COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) * 4.0
          <= COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories)
    THEN COALESCE(verified_nutrition.protein_grams, machine_nutrition.protein_grams, n.protein_grams) * 100.0
         / COALESCE(verified_nutrition.calories, machine_nutrition.calories, n.calories)
  END AS sort_protein_density
FROM products p
LEFT JOIN nutrition_facts n ON n.product_id = p.id
LEFT JOIN current_verified_nutrition_facts verified_nutrition
  ON verified_nutrition.product_id = p.id
LEFT JOIN current_machine_verified_nutrition_facts machine_nutrition
  ON machine_nutrition.product_id = p.id;

UPDATE products SET sort_protein_density = (
  SELECT k.sort_protein_density FROM product_density_sort_keys k
  WHERE k.product_id = products.id
);

CREATE INDEX idx_products_active_density
  ON products(is_active, sort_protein_density DESC, name_normalized, completeness, id);

CREATE TRIGGER density_key_products_insert AFTER INSERT ON products BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.id)
  WHERE id = NEW.id;
END;

-- nutrition_facts is both the fallback fact source and a candidates-view input.
CREATE TRIGGER density_key_nutrition_insert AFTER INSERT ON nutrition_facts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_nutrition_update AFTER UPDATE ON nutrition_facts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_nutrition_delete AFTER DELETE ON nutrition_facts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

CREATE TRIGGER density_key_machine_nutrition_insert AFTER INSERT ON machine_nutrition_verifications BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_machine_nutrition_update AFTER UPDATE ON machine_nutrition_verifications BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_machine_nutrition_delete AFTER DELETE ON machine_nutrition_verifications BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

-- current_exact_verified_evidence_decisions inputs (decisions, attempts,
-- attempt labels, label assets, and both source_records bindings).
CREATE TRIGGER density_key_evidence_decision_insert AFTER INSERT ON evidence_decisions BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_evidence_decision_update AFTER UPDATE ON evidence_decisions BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_evidence_decision_delete AFTER DELETE ON evidence_decisions BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

CREATE TRIGGER density_key_extraction_attempt_insert AFTER INSERT ON extraction_attempts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_extraction_attempt_update AFTER UPDATE ON extraction_attempts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_extraction_attempt_delete AFTER DELETE ON extraction_attempts BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

-- attempt labels have no product_id; the product lives on the attempt.
CREATE TRIGGER density_key_attempt_label_insert AFTER INSERT ON extraction_attempt_labels BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = (SELECT product_id FROM extraction_attempts WHERE id = NEW.attempt_id))
  WHERE id = (SELECT product_id FROM extraction_attempts WHERE id = NEW.attempt_id);
END;
CREATE TRIGGER density_key_attempt_label_update AFTER UPDATE ON extraction_attempt_labels BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN
      (SELECT product_id FROM extraction_attempts WHERE id IN (OLD.attempt_id, NEW.attempt_id)))
  WHERE id IN
    (SELECT product_id FROM extraction_attempts WHERE id IN (OLD.attempt_id, NEW.attempt_id));
END;
CREATE TRIGGER density_key_attempt_label_delete AFTER DELETE ON extraction_attempt_labels BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = (SELECT product_id FROM extraction_attempts WHERE id = OLD.attempt_id))
  WHERE id = (SELECT product_id FROM extraction_attempts WHERE id = OLD.attempt_id);
END;

CREATE TRIGGER density_key_label_asset_insert AFTER INSERT ON label_evidence_assets BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_label_asset_update AFTER UPDATE ON label_evidence_assets BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_label_asset_delete AFTER DELETE ON label_evidence_assets BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

-- source_records appear twice in the evidence chain (subject + derived rows).
CREATE TRIGGER density_key_source_record_insert AFTER INSERT ON source_records BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = NEW.product_id)
  WHERE id = NEW.product_id;
END;
CREATE TRIGGER density_key_source_record_update AFTER UPDATE ON source_records BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id IN (OLD.product_id, NEW.product_id))
  WHERE id IN (OLD.product_id, NEW.product_id);
END;
CREATE TRIGGER density_key_source_record_delete AFTER DELETE ON source_records BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = OLD.product_id)
  WHERE id = OLD.product_id;
END;

-- sources feed the official/brand candidate arm globally, so a source change
-- can move any product's key.
CREATE TRIGGER density_key_source_insert AFTER INSERT ON sources BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = products.id);
END;
CREATE TRIGGER density_key_source_update AFTER UPDATE ON sources BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = products.id);
END;
CREATE TRIGGER density_key_source_delete AFTER DELETE ON sources BEGIN
  UPDATE products SET sort_protein_density = (
    SELECT k.sort_protein_density FROM product_density_sort_keys k
    WHERE k.product_id = products.id);
END;
