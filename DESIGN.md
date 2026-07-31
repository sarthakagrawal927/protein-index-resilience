---
name: Protein Index
description: Evidence-first Indian protein product intelligence
colors:
  ink: "#17221c"
  muted: "#566158"
  line: "#d8d8cc"
  paper: "#fbfaf5"
  paper-deep: "#efeee6"
  green: "#0c6b47"
  green-deep: "#074b34"
  green-soft: "#dcefe4"
  amber: "#8b5a12"
  amber-soft: "#f4e6c2"
typography:
  display:
    fontFamily: "Georgia, Times New Roman, serif"
    fontWeight: 500
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.6
rounded:
  field: "8px"
  surface: "14px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "20px"
  lg: "40px"
components:
  surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "{spacing.md}"
---

# Design System: Protein Index

## Overview

**Creative North Star: "The Evidence Ledger"**

Protein Index is dense, restrained, and auditable. Warm paper surfaces and dark botanical ink make the catalog approachable; controlled green marks verified or primary information while amber and red communicate uncertainty without spectacle. Product facts lead, decoration recedes.

## Colors

Use paper neutrals for structure and reserve green for identity, action, and positive evidence state. Amber communicates unverified evidence; red communicates conflicts or errors.

## Typography

Georgia carries product names and major numeric emphasis. Inter and the system sans stack carry navigation, labels, tables, and explanatory copy. Keep body measure near 70 characters and never tighten display tracking beyond `-0.04em`.

## Layout

The dashboard uses a wide, dense desktop canvas and collapses to macro-first cards on mobile. New read surfaces use a centered `70ch` column, a compact identity header, and responsive macro grids with generous separation between evidence groups.

## Elevation & Depth

Surfaces are bordered and tonally layered. The single ambient shadow (`0 20px 55px rgba(23, 34, 28, .07)`) is reserved for primary containers; status and metric groups remain flat.

## Shapes

Fields use 8px corners, primary surfaces 14px, and small state labels use pills. The asymmetrical PI mark is the only ornamental silhouette.

## Components

Product identity pairs a serif title with compact sans metadata. Macro facts use a flat responsive grid; evidence state uses concise colored labels. Links are green, underlined on hover, and visibly focused.

## Do's and Don'ts

### Do:

- **Do** preserve the five-macro and protein-density hierarchy.
- **Do** label missing, unverified, machine-verified, and verified states explicitly.
- **Do** use semantic HTML and visible keyboard focus.

### Don't:

- **Don't** expose provenance, review mutations, private artifacts, or operational controls on consumer pages.
- **Don't** imply complete Indian-market coverage or invent absent nutrition.
- **Don't** introduce a competing palette or dashboard layout for route-level detail.
