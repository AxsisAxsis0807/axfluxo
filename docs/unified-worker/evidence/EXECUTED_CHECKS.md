# Executed checks and evidence index

Overall **PARTIAL**. Production-source commit:
`b60c7372cf449d10c2984453a598dee20692855e`; subsequent changes are audit
scripts/reports/evidence only. Final PR SHA and GitHub Actions are reported in
the PR/session; do not substitute a parent SHA's CI for final-SHA status.

## Successful local checks

| Check                                                  | Result                                                                      | Log                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------- |
| `npm run typecheck`                                    | PASS                                                                        | [typecheck](logs/typecheck.log)         |
| `npm run lint`                                         | PASS, including diagnostic JavaScript                                       | [lint](logs/lint.log)                   |
| `npm test -- --maxWorkers=1`                           | 60 files, **511 tests PASS**                                                | [unit tests](logs/unit-tests.log)       |
| `npm run build`                                        | PASS with the existing CI public auth fixture configuration                 | [build](logs/build.log)                 |
| Worker/export-worker/render/API builds                 | PASS                                                                        | [worker builds](logs/worker-build.log)  |
| Existing rendering/reference/graphics/checkpoint tests | Included in 511 PASS; no expected values weakened                           | [unit tests](logs/unit-tests.log)       |
| New recovery Promise barriers                          | **11 PASS**                                                                 | [barriers](logs/recovery-barriers.log)  |
| Video browser Chromium                                 | **48 PASS**                                                                 | [Chromium](logs/chromium.log)           |
| Frontend Playwright desktop/mobile                     | **124 PASS**                                                                | [E2E](logs/e2e.log)                     |
| Native PostgreSQL Export queue                         | **21 PASS**, including added stale progress/publish and attempt assertions  | [queue](logs/native-export-queue.log)   |
| Native PostgreSQL real Export                          | **1 PASS**, 1080p60 synthetic input and ranged MP4 output                   | [Export](logs/native-export-render.log) |
| Reference before/after quality                         | 5 seconds, 300 frames, two titles/six segments, entire output SHA identical | [reference](logs/reference-quality.log) |

The successful frontend build followed a failed build caused by moving
dependencies outside Turbopack's workspace root during disk recovery. Restoring
them locally resolved that environment issue without a source/config change.
The initial E2E build lacked public test auth settings; that run was interrupted
and superseded by the configured build and 124-test successful run. Test auth
requests are intercepted by the existing fixtures; no production DB mutation
was performed. Dependencies were subsequently relocated again to preserve disk
reserve; the source tree was not changed by those moves.

## Baseline comparisons and unresolved checks

| Check                             | PR #33                                | PR #34                         | Candidate / conclusion                                                      |
| --------------------------------- | ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Native Drive shared refresh lease | 29 PASS / same 1 timeout              | 29 PASS / same 1 timeout       | 29 PASS / same 1 timeout; pre-existing, not fixed                           |
| Chromium Local FNF completion     | 1 FAIL (expected 2 completed, got 0)  | 1 PASS in focused run          | PASS in full 48; historical intermittent failure not declared cured         |
| Focused WebKit editor             | Launch FAIL: missing binary           | Same launch FAIL               | Initial all-browser run also launch FAIL; install attempts returned HTTP403 |
| Production Docker image           | Dockerfile identical in baseline path | APT network failure reproduced | Normal/host-network builds FAIL; diagnostic image is different              |

Logs: [Drive #33](logs/native-drive-pr33.log),
[Drive #34](logs/native-drive-pr34.log),
[Drive candidate](logs/native-drive-candidate.log),
[FNF #33](logs/baseline-fnf-pr33.log),
[FNF #34](logs/baseline-fnf-pr34.log),
[WebKit #33](logs/webkit-pr33.log),
[WebKit #34](logs/webkit-pr34.log),
[WebKit download](logs/webkit-install.log),
[Docker](logs/docker-build.log), [Docker host networking](logs/docker-build-host.log).

The fresh-DB candidate native Generic Render suite was blocked by disk reserve;
its PGlite version is included in the final 511 PASS, but **final native Generic
Render is not certified**. Initial multi-suite native runs incorrectly reused
one database, causing schema-already-exists; a readiness race, dependency-path
failure and ENOSPC also occurred during harness recovery. These runs are not
product passes. The corrected native queue and real Export logs above supersede
their corresponding invalid attempts, not all native suites.

## Resource evidence

- [Exploratory matrix](resource-audit-v2-exploratory.json): 36 completed records,
  32 successful U/M runs and four S OOM failures. Includes a rejected FNF
  experiment. Twelve matched AV pairs and four experimental FNF pairs were
  byte identical. Recorded bundle/image identities identify measured artifacts;
  the candidate then was an uncommitted worktree based on #34.
- [Final-code attempt](resource-audit-v2-final-attempt.json): 76 planned cases,
  first container could not create `/work/result` due to ENOSPC,
  [startup error](logs/final-resource-startup-enospc.log); 75 disk-gated cases.
  **No final-code constrained performance result** is inferred from it.
- S legacy: both repetitions of each version OOM-killed FFmpeg; kernel events,
  child signals, exit code and missing validation are recorded. The parent
  container's `OOMKilled=false` does not turn child OOM into success.
- No 5-second/30-second full resource matrix, real-provider resource trial,
  production image constrained trial, real Blitz trial or physical Safari trial.

JSON `sourceHashesAtEvidenceGeneration` and `gitHeadAtEvidenceGeneration` name
the tree when the evidence was assembled. They are **not** the historical
uncommitted candidate's Git SHA. Use the manifests' actual bundle/image hashes
and the explicit provenance note. `log-sha256.json` covers copied logs. Complete
raw samples and synthetic media remain in the work directories/retained named
containers; no large videos or source credentials are committed to Git.
