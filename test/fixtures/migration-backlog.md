# Backlog

## In flight
- **build-a1** - SHIP build the adapter (repo: example) (priority: 0) (since 2026-01-02)
  ## Intent
  Keep the original body.

  Second paragraph.
- [ ] inspect-a2 - SCOUT inspect the API (repo: example) (since 2026-01-03)

## Queued
- [ ] held-q1 - wait for review (kind: task) (repo: example) (priority: 1) (since 2026-01-04) (hold: review pending) (hold-kind: captain) (hold-until: 2099-01-01)
  Reviewer notes.
- [ ] blocked-q2 - DOCS-ONLY publish docs (repo: docs) (priority: 3) blocked-by: build-a1 - needs the adapter first
- [ ] ready-q3 - publish report data/ready-q3/report.md (kind: docs) (priority: 4) (hold: old release window) (hold-kind: future) (hold-until: 2000-01-01) parent: inspect-a2 - tracks the investigation discovered-from: old-d2 - followup from the prior release

## Done
- [x] latest-d1 - SHIP release https://github.com/example/project/pull/7 (repo: example) (priority: 2) (merged 2026-02-02)
  Released successfully.
