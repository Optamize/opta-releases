---
id: nexus.readme.repos.opta-releases.scripts.readme
title: scripts/
domain: ops
status: reference
audience:
- shared
source_type: index
owner: shared
updated: '2026-06-12'
confidence: medium
retrieval_tags:
- readme
privacy: internal
provenance:
  primary_model: claude-fable-5
  primary_agent: claude48
  chain_ref: prv_opta64_1411
  generated: 2026-06-11
uid: 265b5cd3-49d3-40bf-a1ff-c993c3dc1fe3
---

# scripts/

`doctor.mjs` — validates the entire update plane: serving endpoints (primary + failover),
manifest schemas (`latest.json` + `release.meta.json`), asset reachability, minisign signature
structure against the fleet key `5F4DCA2AABE47146`, history immutability, and index agreement.

    node scripts/doctor.mjs          # human-readable PASS/WARN/FAIL table
    node scripts/doctor.mjs --json   # machine-readable report (opta.doctor-report/1)

Exit 0 = all pass/warn · exit 1 = any fail. Zero dependencies, Node >= 20, runnable from any cwd.
Cron intent: at U2+, Mono512 crons `--json` output into the status feed (`public/v1/feeds/`).
