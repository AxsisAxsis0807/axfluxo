# Recovery Audit v2

Status: **PARTIAL**. No queue, lease, fencing, retry, RLS, TLS, storage or cleanup
production code is changed. This table distinguishes a deterministic mocked
orchestration barrier from an actual DB/process test. These are implementer
reviews from different viewpoints, not five independent external reviewers.

`server/tests/resource-recovery-v2.test.ts` uses controlled Promises instead of
timing luck. Cases 05–07 hold the injected renderer at the requested logical
boundary: they do not interrupt a real Canvas kernel or real segment write.
The existing runtime suite separately aborts real FFmpeg and tests real
SIGTERM/SIGINT, a TERM-resistant child and escalation to SIGKILL.

| #   | Stop race                          | Evidence / limitation                                                                                                                                                      |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Before claim                       | Aborted signal rejects; no claim/publish. Also existing SQL queue test leaves job queued                                                                                   |
| 02  | Claim in flight                    | Barrier returns acquired claim after abort; renderer never starts; acquired attempt is failed/requeued via existing handler                                                |
| 03  | Immediately after successful claim | Abort at claim resolution; no preparation/publication                                                                                                                      |
| 04  | Material download                  | Generator barrier; renderer/storage/publication never start after abort                                                                                                    |
| 05  | Background generation              | Renderer-adapter barrier; actual native Canvas interruption remains unverified                                                                                             |
| 06  | FFmpeg encode                      | Adapter barrier plus existing real FFmpeg abort/child-close test; exact production segment timing not fully covered                                                        |
| 07  | Segment complete                   | Renderer-adapter completion barrier; no storage/publish; real checkpoint boundary SIGTERM remains unverified                                                               |
| 08  | Output storage                     | Storage barrier drained; abort prevents publish; existing immutable storage rules unchanged                                                                                |
| 09  | Just before publish                | Final hash barrier; abort prevents call to publish                                                                                                                         |
| 10  | Publish in flight                  | Publish awaited once and no extra failure transition in orchestration test; actual DB commit-vs-SIGTERM interleaving remains unverified                                    |
| 11  | Heartbeat failure + shutdown       | Timer controlled; in-flight heartbeat drained before attempt transition; no publish; existing heartbeat suite distinguishes cancellation, lease, disk and storage failures |
| 12  | Expired lease + restart            | Existing DB expiry/reclaim gives new token; generic Render suite includes an actual killed process with native DB recovery; not a full legacy process restart test         |
| 13  | Explicit cancel + shutdown         | Existing DB test keeps terminal state cancelled, not worker-loss failure                                                                                                   |
| 14  | Third attempt shutdown             | Existing DB test reaches queued/queued/failed and refuses fourth claim; added assertions require attempts to remain 1/2/3                                                  |
| 15  | Delayed old-worker writes          | Extended DB test rejects stale heartbeat, progress and publish; stale failure handler cannot mutate the new attempt                                                        |

The 11 new orchestration tests passed after correcting their test double:
initially the mocked `finishFailure` returned undefined instead of the real
Promise contract. That initial test-harness failure is retained in the work log;
no production assertion was weakened to hide it.

Original/synthetic validated file and foreign checkpoint sentinels remain intact
after each new barrier test. No original/checkpoint purge or automatic retention
change was added. Queue-role tests verify ownership, private output access,
cancellation, bounded attempts and fencing. Existing Render tests validate
checkpoint reuse/rejection and transaction rollback. Mock barriers alone do not
prove real DB atomicity, media quality, child termination or crash durability.

Native PostgreSQL runs must use a password-authenticated, loopback-only disposable
container. Every suite needs its own fresh database because its migrations are
not idempotent. An initial multi-suite/shared-DB attempt failed with schema-already-
exists and was rejected as a harness error. A subsequent run hit host disk
exhaustion; neither is reported as product regression or test success.
The runner was corrected to require fresh databases and a disk reserve.

## Five audit viewpoints

1. **Specification — partial:** two All Versions files only; input decoder options
   preserve dimensions, CFR60/CRF18/H.264/yuv420p/BT.709, filters, timer/fades,
   output encoder configuration, direct mux, single output and profile identity.
   Exact output hashes and existing reference/pixel tests provide bounded
   evidence; arbitrary input/platform equivalence is not proven.
2. **Code/execution — partial:** TypeScript/lint/build, existing tests and new
   barriers executed. No additional concurrent worker loop, pool, persistent
   Buffer, cache or retained child introduced. See executed-results evidence for
   final statuses, including environment failures and retries.
3. **Security — scoped review passed:** no auth/owner/RLS/TLS/fence/SQL changes,
   no production/provider connections, no admission flag change, no secret-bearing
   command/environment/path logging in the diagnostic child. Diagnostic artifacts
   contain synthetic paths only. This is not a comprehensive security certification.
4. **Resources — partial:** measured FFmpeg contribution and PNG decoder experiment;
   real cgroup limits/swap/CPU verified where tests ran. 512MiB OOM is a failed
   operating profile. Diagnostic runtime differs from production image. Long and
   real-provider workloads remain gated; no account capacity/cost guarantee.
5. **Recovery/release — partial:** controlled barriers and SQL/process regression
   checks, with the explicit gaps above. OOM was actually observed. No general
   recovery or long-video approval follows from detecting OOM. Rollback is to
   the PR #34 binary without deleting files, reverting migrations, or enabling
   flags. User/GPT-6 review is required before any later release decision.

## Remaining tests before release

Native Canvas stop; real legacy FFmpeg/segment/checkpoint stop barriers;
interrupting the publication transaction at controlled commit points; repeated
worker OOM/restart with retained disk; provider interruption and original/hash
readback; long idle/leak runs; real production-image constrained trials;
physical iPhone Safari. Test success on simulated WebKit is not physical Safari.
