# 0001. Record architecture decisions

Date: 2026-10-11 · Status: accepted

## Context
The MVP is built largely autonomously. The owner needs to see why things are the way they are without reading every commit.

## Decision
Significant decisions are recorded as short ADRs in `docs/adr/NNNN-title.md` (context, decision, consequences). Findings from checking external providers' current docs are recorded in the ADR for that integration.

## Consequences
New sessions read `docs/adr` before changing an affected area. A superseded ADR is marked as superseded, not deleted.
