# macro-first-product-detail Specification

## Purpose

Keep protein comparison focused on the five shopper-facing macros and protein
density, without evidence-management detail in the consumer experience.
## Requirements
### Requirement: Direct macro comparison

The catalog SHALL show protein, carbohydrate, fat, fibre, calories, and
protein per 100 kcal directly for each product without requiring a product
detail interaction.

#### Scenario: Shopper scans a desktop result

- **WHEN** a product is rendered in the catalog table
- **THEN** its five macros and protein density are visible as table columns.

#### Scenario: Shopper scans a mobile result

- **WHEN** a product is rendered as a mobile card
- **THEN** its five macros and protein density are visible in the card.

### Requirement: Concise consumer product detail

The consumer product drawer, canonical HTML page, and Markdown mirror SHALL show only product identity, the five macros, protein density, and concise evidence-state labels, and SHALL NOT show expandable provenance, review mutation, private artifact, or source-record sections.

#### Scenario: Shopper opens a product

- **WHEN** a product drawer is rendered
- **THEN** it contains no provenance, source-record, ingredient, rating, or additional-nutrient drill-down section.

#### Scenario: Crawler or agent opens a product

- **WHEN** a canonical HTML page or Markdown mirror is rendered
- **THEN** it contains the same public product identity, macro values, protein density, and evidence-state labels without private or operational detail.
