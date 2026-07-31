# public-product-discovery Specification

## Purpose
Give every active public Protein Index product a truthful, crawlable, source-derived route contract for search engines and non-JavaScript agents.
## Requirements
### Requirement: Active products define the public route inventory
The system SHALL derive the public product route inventory from active canonical products and SHALL exclude inactive products, review mutations, private evidence artifacts, and template routes.

#### Scenario: Active product is inventoried
- **WHEN** an active canonical product exists
- **THEN** the inventory contains one encoded canonical HTML path and one equivalent Markdown path for that product

#### Scenario: Non-public records are excluded
- **WHEN** discovery surfaces are generated
- **THEN** inactive products and private or operational records do not appear

### Requirement: Runtime sitemap and catalog are exhaustive
The system SHALL generate `/sitemap.xml` and `/api/ai` from the same active-product inventory.

#### Scenario: Crawler requests sitemap
- **WHEN** `/sitemap.xml` is requested
- **THEN** it contains the homepage and every active product HTML URL exactly once and contains no API, Markdown, mutation, or private-artifact URL

#### Scenario: Agent requests catalog
- **WHEN** `/api/ai` is requested
- **THEN** it describes every active product's canonical HTML and Markdown URLs and the stable discovery entrypoints

### Requirement: Discovery metadata is truthful
Every canonical product HTML response SHALL expose an absolute self-canonical URL, matching Open Graph URL, indexable robots metadata, and Product structured data derived from the public product projection.

#### Scenario: Product metadata is rendered
- **WHEN** a crawler requests an active product HTML route
- **THEN** the title, description, canonical URL, Open Graph metadata, and structured data identify that exact product without unsupported claims

### Requirement: Route representations preserve evidence boundaries
HTML and Markdown product routes SHALL use the existing public product projection, preserve its Trusted/Discovery evidence labels, and SHALL NOT expose review mutations or private retained artifacts.

#### Scenario: HTML and Markdown are compared
- **WHEN** both representations are requested for one active product
- **THEN** they identify the same product and present the same public macro and evidence-state facts

