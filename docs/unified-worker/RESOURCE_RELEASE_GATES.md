# Resource release gates

**No production deployment or admission enablement is approved.** Existing
Cloud flags, including unified/export/compositor defaults, remain OFF. Do not
merge existing PRs, push main, migrate a production database, change Blitz,
operate real Drive/R2 objects, activate trials or register payments.

## Official publication, checked 2026-11-16

Both [limits](https://blitz.cloud/docs/limits/) and
[terms](https://blitz.cloud/terms/) still say updated 12 November 2026.
Direct shell fetch returned 403; the web source reader retrieved the official
pages. The following summarizes the relevant published limits, not this account.

| Item             | Published reservation | Published ceiling                   |
| ---------------- | --------------------- | ----------------------------------- |
| Free memory pool | 512MB = 512,000,000 B | Reservation pool, not a worker cap  |
| Small            | 128MB = 128,000,000 B | 512MB = 512,000,000 B               |
| Medium           | 256MB = 256,000,000 B | 1GB = 1,000,000,000 B               |
| PostgreSQL       | 128MB = 128,000,000 B | Account/runtime confirmation needed |

The decimal conversions above are explicit audit conventions for the published
MB/GB labels, **not verified Blitz cgroup byte values**. S's 536,870,912-byte
limit is larger than decimal 512MB. M's limit is exactly one decimal GB.

Free also lists five apps, one database, 10GB reserved storage and shared burst
ceilings; each running compose part counts as an app. Small CPU reserve/ceiling
is 0.05/0.5 core, Medium 0.1/1 core. This audit's 1-core probes do not establish
Small's 0.5-core behavior. Shared capacity and reservations remain separate.

An addressed Free app sleeps after 15 minutes without a human visit; program
requests do not wake it. Background workers without addresses do not sleep,
but stop after 24 hours of account inactivity (48 hours for eligible older
accounts). DB sleep follows linked apps. Free accounts have one background part.

Under the terms, signup country as determined by the provider controls regional
Free eligibility: EU/EEA/UK/Switzerland have no stated expiry, others/unknown get
seven days, with older-account exceptions. Paused data retention is at least
30 days. Minimum signup age is 16; account and purchase eligibility require
operator confirmation. The German terms prevail if translations differ.

Do not infer signup country, age, eligibility, available quota, plan status or
grandfathering from language, local timezone or this test environment. Do not
interact with plan controls: reaching limits may trigger trial behavior under
the published terms, which this task does not authorize.

## Account-specific items — all unverified

- Actual plan, signup-region eligibility, account dates and applicable terms.
- Current reserved memory, apps/parts/background allowance, DB/storage quotas,
  competing apps, CPU access and exact runtime memory/swap byte limits.
- Worker inactivity-stop rules, platform restarts, OOM resize behavior, sleep,
  DB reachability and restart ordering for this deployment.
- Durable scratch disk capacity, throughput, available reserve and preservation
  of original/checkpoint/output across stop, restart, rollback and OOM.
- No paid plan, trial, card, billing or quota change was performed.

Small API + Medium Worker + PostgreSQL sums to published reservations of
128+256+128=512MB. This is arithmetic only; it is not account fit, actual free
capacity, app-count fit, CPU availability or stability evidence.

## Required release evidence

1. User/GPT-6 review of the Draft and final-SHA CI, including unresolved failures.
2. Correctly built production image and repeated identical-input constrained
   trials at the **actual** selected platform limit, including long/complex AV,
   reference timer and separate FNF ranges. Maintain disk reserve and swap policy.
3. Complete quality/audio/timestamp/decode evidence and profile/checkpoint
   compatibility. No resolution/FPS/CRF/blur/crop/layout changes to fit memory.
4. Close the real native-operation/publication/restart gaps in recovery report.
5. Confirm owner/RLS/fencing/TLS, real worker count and old-worker shutdown,
   cancellation semantics, three-attempt limit, ready-only publication,
   preserved originals and non-destructive rollback.
6. Operator confirms account eligibility/capacity and external tests under a
   separately authorized task. No test here certifies Blitz operation.

512MiB OOM excludes that profile for the observed renderer. A 1GB short probe
may justify further investigation, never long-video or unattended Free operation.
Insufficient tests/environment access means PARTIAL; unsafe operation or a
quality/security/data-integrity regression requires HOLD for that target.
