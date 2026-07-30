## ADDED Requirements

### Requirement: Canonical public route inventory
The system SHALL publish one canonical homepage and one canonical HTML detail
page for every active product, and SHALL exclude inactive products.

#### Scenario: Active product inventory
- **WHEN** the database contains active and inactive products
- **THEN** only the active product IDs appear in public product sitemaps and resolve as canonical detail pages

### Requirement: Equivalent agent-readable representations
The system SHALL provide substantive Markdown for the homepage and every
canonical product detail page, generated from the same product evidence used by
the HTML representation.

#### Scenario: Product representation parity
- **WHEN** an active product HTML page and its `.md` sibling are requested
- **THEN** both identify the same product, canonical URL, nutrition status, and available evidence without inventing missing values

### Requirement: Bounded exhaustive sitemap
The system SHALL expose a sitemap index whose static and bounded product shards
cover every canonical HTML page exactly through the shared public route
contract.

#### Scenario: Catalog exceeds one shard
- **WHEN** the active product count exceeds the configured shard size
- **THEN** the sitemap index references enough ordered shards to cover the complete active set

### Requirement: Complete agent catalog
The system SHALL expose an `/api/ai` catalog that describes the canonical
homepage and complete dynamic product collection with an exact active count,
URL templates, Markdown templates, and sitemap discovery.

#### Scenario: Catalog inspection
- **WHEN** an agent requests `/api/ai`
- **THEN** it can discover both canonical route templates and the exact number of active product pages without expanding an unbounded surface list

### Requirement: Search metadata
Every canonical HTML page SHALL include a unique title, description, canonical
URL, indexing directive, Open Graph metadata, Twitter metadata, and relevant
JSON-LD structured data.

#### Scenario: Product metadata
- **WHEN** an active product detail page is rendered
- **THEN** its metadata and structured data identify that product and its canonical detail URL

### Requirement: Evidence boundary
Public HTML, Markdown, and catalog output MUST preserve the existing distinction
between verified evidence, unverified data, and missing values, and MUST NOT
expose local-only review mutations.

#### Scenario: Missing nutrition
- **WHEN** a product lacks verified nutrition evidence
- **THEN** its public representations state that the evidence is unavailable or unverified and do not infer numeric nutrition claims

### Requirement: Missing product behavior
The system SHALL return a not-found response for inactive or unknown product
HTML and Markdown routes.

#### Scenario: Unknown product
- **WHEN** an unknown product ID is requested as HTML or Markdown
- **THEN** the system returns HTTP 404 with no indexable canonical product page
