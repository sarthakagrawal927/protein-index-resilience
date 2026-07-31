## MODIFIED Requirements

### Requirement: Concise consumer product detail

The consumer product drawer, canonical HTML page, and Markdown mirror SHALL show only product identity, the five macros, protein density, and concise evidence-state labels, and SHALL NOT show expandable provenance, review mutation, private artifact, or source-record sections.

#### Scenario: Shopper opens a product

- **WHEN** a product drawer is rendered
- **THEN** it contains no provenance, source-record, ingredient, rating, or additional-nutrient drill-down section.

#### Scenario: Crawler or agent opens a product

- **WHEN** a canonical HTML page or Markdown mirror is rendered
- **THEN** it contains the same public product identity, macro values, protein density, and evidence-state labels without private or operational detail.

