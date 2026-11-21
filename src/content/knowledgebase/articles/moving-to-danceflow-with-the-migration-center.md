---
title: "Moving to DanceFlow with the Migration Center"
slug: moving-to-danceflow-with-the-migration-center
category: "Getting Started"
summary: "Use the Migration Center to import, map, review, and reconcile data when moving to DanceFlow from another studio system."
order: 790
visibility: public
---

## Overview

The Migration Center helps studios move existing business data into DanceFlow with less manual setup.

The goal is to guide the move, identify gaps, and surface only the records that need studio attention.

## Supported migration workflows

Migration tools can support data coming from common studio-management systems and structured exports, including workflows for:

- WellnessLiving
- Mindbody
- Square
- CSV or spreadsheet-based data

Available fields and import depth depend on the source data provided.

## Typical migration flow

1. Open **Settings > Import / Migration Center**.
2. Choose the source system or import type.
3. Upload the exported file.
4. Review detected fields and mappings.
5. Confirm or correct fields that could not be mapped automatically.
6. Run the import.
7. Review failed rows, warnings, duplicates, and reconciliation items.
8. Confirm the migrated records in DanceFlow.

## Mapping

DanceFlow attempts to connect source fields to the correct DanceFlow records.

Examples include client names, contact details, package information, memberships, payments, and other supported data.

Only ambiguous or unsupported mappings should require manual input.

## Reconciliation

After import, review the reconciliation results.

Pay attention to:

- Failed rows
- Duplicate records
- Missing required information
- Unmatched source values
- Payment or balance differences
- Records that need a studio decision

## ARIA and migration support

ARIA can surface import batches with failed rows or unresolved warnings so migration problems do not disappear after the initial upload.

## Best practice

Keep the original export as a backup until the migration has been reviewed and reconciled.

Do not treat a migration as complete until the important client, schedule, package, membership, and financial records have been spot-checked.
