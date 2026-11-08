# AxFluxo Video V1 server foundation

2026-11-01 JST。開始時main/APIとgit fetchは `367fb02570b4782aa5f51e892718fc473b376c59`。V0ローカルcommit `a19f2b6` を引き継ぎ、`feat/video-v1` で実装。AGENTS.mdはリポジトリ/祖先になし。README、ADR 001–006、V0設計、未マージdraft PR #8の変更12パスを再確認した。PR #8の固定入力・上流実行・作業版復帰には触れない。V0 schemaは変更しない。

## 境界と起動

独立NodeサービスでありNextのroute/server actionではない。既存静的export、Supabaseログイン、4つのIndexedDB、V0のdeveloper DB、バックアップ形式は変更しない。serverはnpm workspaceで、既存 `npm ci` が追加依存を再現できる。ブラウザーが参照するのは純粋な `contracts/video.ts` だけで、`api/` と `db/` はサーバー専用。フロントエンドにDB接続文字列/service role鍵を渡さない。既存の制作画面の導線は変更せず、静的な開発者診断画面 `/developer/video/` を追加する（basePathがあればその配下）。`NEXT_PUBLIC_VIDEO_API_ORIGIN` が未設定なら通信せず保留表示にする。設定値はAPIの公開originだけでありsecretではない。診断画面では権限確認と所有batchの状態確認を行い、新規動画編集UIは追加しない。postbuildはこの新規pathだけにindex.htmlを用意し、NextのRSC用directoryと静的hostのdirectory解決を両立する。既存rootのexport/serve契約は変更しない。

```sh
npm ci
npm test                               # 既存 + V0 + V1統合/クライアント試験
npm test --workspace axfluxo-video-server
npm run test:video:browser -- --project=chromium
npm run test:video:browser -- --project=webkit
# サーバーの独立build（secret不要、静的フロントのbuildとは別）:
npm run build --workspace axfluxo-video-server
# 別途、承認済みのローカルDB設定がある場合のみ:
npm start --workspace axfluxo-video-server
```

起動に必要なserver環境変数:

| 変数                  | 契約                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| VIDEO_JWT_ISSUER      | Supabase JWTの完全なHTTPS issuer。末尾slashなし                             |
| VIDEO_JWT_AUDIENCE    | 期待audience（通常authenticated）。省略不可                                 |
| VIDEO_DATABASE_URL    | 専用PostgreSQL login。URL query/hash不可。secretでありNEXT_PUBLICにしない   |
| VIDEO_ALLOWED_ORIGINS | 完全originのcomma区切り。wildcard/null不可。HTTPSまたは開発時localhost HTTP |
| VIDEO_ACCEPTING       | `true` の場合のみ新規受付・retryを許可。既定false                           |
| VIDEO_UNITS_PER_FRAME | 1–1,000,000の整数。未設定は受付503。フレーム数はサーバーで算出              |
| VIDEO_API_PORT        | PORTが未設定の場合に使用。既定3100。bindはVIDEO_API_HOST（既定0.0.0.0）で指定する |
| NODE_ENV              | development/test以外（未設定含む）はDB TLS証明書検証を必須化                |

サーバーbuildはwork/video-server/api.mjsへ出力し、秘密値を埋め込まない。リリース時は別の配布先を決め、runtime依存のみを配置できる。開発用の直接起動は `npm run dev --workspace axfluxo-video-server`。サービスはmigrationを自動実行しない。起動設定不備・request error・pool errorのraw例外、JWT、secret、snapshot、素材名、署名URLをlogに出さない。reverse proxy/APMもAuthorization/header/body/queryの記録を無効化・redactする運用が必要。DB secretはサーバーのsecret管理だけに設定する。

## APIと認可

| method/path                  | body / response                                             |
| ---------------------------- | ----------------------------------------------------------- |
| GET /v1/developer/me         | ownerIdとdeveloper membership                               |
| POST /render-batches         | `{snapshot: FnfSnapshot v1}` / batchと待機job               |
| GET /render-batches/:id      | ownerに属するbatch、全試行job、固定version/hashのoutput参照 |
| POST /render-jobs/:id/retry  | `{}` / 新しい試行job                                        |
| POST /render-jobs/:id/cancel | `{}` / 永続化された取消要求                                 |

POSTは `Idempotency-Key`（8–128文字、英数字/`.`/`_`/`:`/`-`）必須。JSONは最大1MiB、100clip/100範囲まで。owner_idや費用はbodyで受け取らない。jobの対象ownerはJWTのsubから決める。

JWTはJOSEで署名・issuer・audience・exp・iat・nbfを検証。exp/sub/iatを必須とし、ES256/RS256だけを許可する。固定issuer配下のJWKSのみ参照し、JWT内の任意URLは使わない。roleはauthenticatedのみ。user_metadata/app_metadataのdeveloper申告を認可に利用しない。署名検証不能/JWKS障害も拒否し、復号なしのpayloadを信用しない。

毎request、transaction内でmembershipのactive/有効期限をDB照会しshare lockする。失効処理が完了した後のrequestや同じ冪等キーの再送も403。進行中transactionのmembership lockはcommitまで保持する。対象行はowner条件を必須としRLSを併用。他ownerや不存在は404。原本はprivate resource_versionsのowner/library/file/version/hash/kindすべてを照合する。クライアントが手元DBの素材を勝手に登録するendpointはなく、未登録参照は404になる。

CORSは完全originを照合し、許可されたGET/POSTとAuthorization/Content-Type/Idempotency-Keyだけをpreflightで返す。cookie認証を使わず、CORSだけを認可にしない。応答はno-store。ブラウザークライアントはcredentials omit、redirect errorとし、予期しないリダイレクト先へtokenを渡さない。

## DB / transaction / 予算

全追加tableは非公開schema `axfluxo_video`。public tableは作らない。全tableでowner_id NOT NULL、RLSをENABLE/FORCE、owner policyを設定。PUBLIC/anon/authenticated/service_roleにはschema/tableアクセスを付与しない。専用NOLOGIN group `axfluxo_video_api` を専用DB loginへ管理者が付与し、毎transactionでSET LOCAL ROLEする。JWTから得たownerだけをtransaction-local GUCへ設定する。秘密のDB login自体は信頼境界内にあり、ブラウザーへ公開しない。

| table                 | 用途                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| developer_memberships | 管理者が付与/失効。APIはSELECTと行lock用timestamp権限のみ            |
| render_batches        | 不変snapshot/hash                                                    |
| render_jobs           | 範囲別の永続試行、retry lineage、取消要求                            |
| render_outputs        | 不変のoutput参照。APIはreadのみ                                      |
| resource_pins         | owner付きの固定原本version/hashを保持                                |
| outbox_events         | render.requested/cancel.requestedの永続配送待ち                      |
| usage_reservations    | jobごとの予約費用、reserved/consumed/released                        |
| audit_events          | 成功した変更のactionとIDだけ。tokenやsnapshotを含めない              |
| resource_versions     | 追加の所有権カタログ。管理者/将来の信頼済み取込adapterだけが新規登録 |
| usage_budgets         | 追加のowner別予算/予約/消費残高                                      |
| idempotency_requests  | 追加の全変更API共通の冪等台帳                                        |

追加3tableは所有権検証、競合しない残高、API間共通の冪等性に必要。既存Supabase table/auth.users/Storage/IndexedDBとの自動連携や変更はない。参照は複合owner FKで照合し、全FKはRESTRICT。原本/output/snapshotはtriggerでもUPDATE/DELETEを拒否する。API roleにDELETE、membership昇格、予算上限変更、原本/output書込権限はない。

同owner+keyをPRIMARY KEYにし、構造検証後の正規化JSON（key順不問・配列順有意）のSHA-256を記録。同内容なら保存済みresponse/statusを返し、別内容/別endpointなら409。別ownerの同keyは独立。同時INSERTはunique constraintで直列化する。

membership → 冪等台帳 → 対象job → owner予算の順でlock。受付は残高をFOR UPDATEし、条件付きUPDATEでも超過を防止する。価格・owner予算未設定は503、超過は409。費用は提出範囲の60fps出力frame数×設定単価。batch、全job、pin、outbox、予約、audit、冪等結果を同一transactionでcommitし、途中失敗時は残高を含めrollback。commit後の応答消失は同keyで再取得できる。

retryはfailed/cancelled/interruptedだけから新jobを作り、原snapshotと資源を再照合して新たに予約する。同一の旧jobからのretryは1つに制限し、別keyでの多重retryを409にする。過去jobやoutputを書き換えない。

取消はcancel_requestedとoutboxを原子的に保存する。成功/失敗済みjobの取消は409。同一取消の再送でeventを増やさない。workerの停止確認前に予算やpinを解放しない。予算精算/解放・outbox claim/delivery・render実行・output公開は次フェーズで、V1は実行成功を偽装しない。将来workerは別の最小権限roleとtransaction、重複配送を考慮したevent idの処理を実装する必要がある。

## フロントエンドとSafari

既存Supabase SDKのgetSession/refreshSessionを注入し、別tokenストレージを作らない。期限間近はsingle-flightで更新し、更新失敗ならstale tokenを送らない。401後は1度だけ更新/再送し、POST body/keyを保持する。一般の通信失敗ではPOSTを自動再送しない。UIは未ログイン/期限切れ/権限なし/待機/保留/失敗/実行中/完了/取消を区別する。表示するのは固定の日本語メッセージで、backendのraw errorを表示しない。複数retryがあるbatchは範囲ごとの最新試行を表示判定に使う。

`DeveloperVideoPanel` は診断画面のhostとして起動時/再確認時にmeを呼び、成功した場合だけbatch状態の照会formを表示する。表示制御とは別に全APIが認可する。`DeveloperVideoStatus` はrole alert/statusで更新失敗を読み上げる。サードパーティcookieに依存せず、端末内の作品・既存認証ストレージを削除しない。WebKit用の実行試験を用意しているが、今回環境の許可host制限でWebKit downloadが403となり実行不可。Chromiumで同じ表示/4DB保持を実行し、CIのchecksにはChromium/WebKitの試験を追加した。実機iPhone Safariの認証/ITP/ネットワーク断は受入時に別途確認が必要。

## migrationとrollback

`db/migrations/001_video_foundation.sql` は明示的承認のある管理者が将来適用する追加SQL。V1作業中の実行はローカル試験DBのみ。契約、cloud作成、本番migration、merge、deployは行わない。role/schemaを作るため管理者権限を要し、アプリ起動時に実行してはいけない。既存schema/DBを変更するSQLやdown migrationはない。

rollbackは `VIDEO_ACCEPTING=false` で再起動して新規/再試行受付を停止する。GETと取消は維持可能。サーバー自体を停止する場合もtable、原本、output、pin、outbox、予約、履歴は残す。古いクライアントやAPI停止を理由に削除・downgrade・自動再配送しない。既存静的フロントと4つのDBはそのまま利用できる。

## 依存と検証

serverのみ: jose 6.2.14 (MIT)、pg 8.23.1 (MIT)、既存と同じzod 4.6.7 (MIT)。開発のみ: PGlite 0.5.14 (Apache-2.0)、tsx 4.23.15/esbuild 0.28.2 (MIT)。既存直接依存のversionは変更なし。ライセンスは各packageの配布物に含まれる。

統合試験はPGliteの実PostgreSQLエンジンを使い、本番SQL/middleware/署名検証を実行する。PGliteの単一backend上でPromise.allによる受付競合を確認する。通常のPostgreSQLに対しても同じ試験を実行できる（本番adapterを使用）。空の専用ローカルDBを用意して `AXFLUXO_TEST_POSTGRES_URL=postgres://...@127.0.0.1:.../axfluxo_video_test_<unique> npx vitest run server/tests/api.integration.test.ts` を実行する。loopbackかつ専用DB名以外は拒否し、試験が既存tableを削除することはない。今回PostgreSQL 18.6の複数接続でも実行済み。複数hostの負荷特性・remote JWKS鍵rotation・実cloud接続の検証は別途必要。検証結果は [V1検証記録](../docs/video/v1-verification.md) を参照。

## Phase 1 runtime configuration

Server-only; never copy these values into `NEXT_PUBLIC_*` variables.

| Setting | Default / compatibility |
| --- | --- |
| `PORT` | First priority, then `VIDEO_API_PORT`, then 3100; decimal integer 1–65535 |
| `VIDEO_API_HOST` | `0.0.0.0`; explicit `127.0.0.1`, `::` or `::1` also accepted |
| `VIDEO_DATABASE_URL` | Existing setting; fallback `DATABASE_URL` |
| `DATABASE_URL` | PostgreSQL URL, no query/fragment/socket options; nonempty host/user/database required |
| DB conflict | Both URLs are validated and must match after protocol alias/default-port normalization; no secret value appears in errors |
| `VIDEO_API_POOL_MAX` | 2, integer 1–10 |
| `VIDEO_WORKER_POOL_MAX` | 1 per role, integer 1–3 |
| `VIDEO_SHUTDOWN_MS` | 20000, integer 3000–120000; process exits with failure if graceful close stalls |
| `VIDEO_WORKER_ENABLED` | Unified entrypoint only, default false |
| `VIDEO_PROBE_ENABLED` | Unified upload cleanup/verification, default false; legacy probe entrypoint selects it explicitly |
| `VIDEO_WORKER_POLL_MS` | 1000, integer 100–60000 |

Production connections retain certificate verification. Existing dedicated
`VIDEO_DELETE_DATABASE_URL` and `VIDEO_NOTIFY_DATABASE_URL` remain supported;
they also accept `DATABASE_URL` fallback, with the same conflict checks.
Credentials that differ also count as a conflict; do not leave a different
provider-injected URL alongside the intended dedicated connection.

Unified worker creates at most four role pools: probe (also preview), render,
delete and notify. Each has max1 by default; together with API max2 this is at
most **6 database connections per API+unified-worker instance**. Disabled roles
do not create pools. Running legacy workers alongside it adds pools and is not
the single-worker configuration. Managed PostgreSQL connection limits and role
capabilities are unverified. The API role never receives worker grants here.

### Start and stop

From the repository root, build and run the API:

```
npm run build --workspace server
npm run start --workspace server
```

Build and run the new unified worker:

```
npm run build:worker --workspace server
npm run worker --workspace server
```

Set `VIDEO_WORKER_ENABLED=true` and the required per-stage flags/configuration
explicitly to run work. Existing render/probe/derivatives commands and
build:deletion/build:notifications bundles remain available. Importing any main
module does not launch a service. With no storage, API render admission,
uploads and preview admission stay closed even if their flags are true.

One pass awaits one unit of upload safety/completion, verification, render,
preview, deletion and notification in that order. Each stage gets a turn per
pass. Render's existing heartbeat/cancel checking continues during encoding;
its claim path also acknowledges cancellation. No separate competing loops are
imported. Failure backoff is per stage, 5/10/20/40/60 seconds (capped); other
stages continue. Existing durable render retries, fencing and held semantics
are unchanged. Notification owners advance by cursor to avoid monopolization.

SIGTERM/SIGINT stop new stages/claims and relay abort to active media work.
Children get TERM and, after two seconds, KILL; media promises wait for close.
Completed storage checkpoints remain; the job is never published as successful
because of shutdown. Lost work is still recovered by existing lease handling;
held resume is **not** implemented in Phase 1. Runtime closes pools and removes
its listeners/timers; the finite process deadline covers stuck network/native I/O.

### HTTP bridge policy

Node 24 `requestTimeout` limits receipt of the request, not handler execution
or response lifetime. `headersTimeout` independently bounds headers. The bridge
adds finite total and no-progress timers covering handler, input and output.
`connectionsCheckingInterval` is at most one second, so Node's header enforcement
has that scheduling granularity. Keepalive idle timeout is five seconds.

| Setting | Default |
| --- | --- |
| `VIDEO_HTTP_HEADERS_MS` | 10000 (maximum 60000) |
| `VIDEO_HTTP_CONTROL_MS` / `VIDEO_HTTP_CONTROL_IDLE_MS` | 30000 / 30000 |
| `VIDEO_HTTP_CHUNK_MS` / `VIDEO_HTTP_CHUNK_IDLE_MS` | 180000 / 30000 |
| `VIDEO_HTTP_CHUNK_BYTES` | 4194304 (maximum 67108864) |
| `VIDEO_HTTP_DOWNLOAD_MS` / `VIDEO_HTTP_DOWNLOAD_IDLE_MS` | 900000 / 60000 |

Timeouts accept positive decimal integers, normally at most 3600000 ms;
download total may be at most 86400000 ms. No timeout accepts zero/infinity.
Node's outer request-receipt ceiling is the maximum configured policy total;
the bridge enforces the shorter selected policy from header completion onward.
The current business routes all use the **control** policy and actual received
body limit of 1 MiB. The JSON parser retains its independent 1 MiB/type check.
Chunk/download policies are only a server-owned bridge extension point for
later phases, not client-selected paths or implemented upload/Range endpoints.
The bridge does not parse binary as JSON. Provider limits may be shorter and
cannot be extended by these settings. Errors expose fixed codes only.

### Rollback

Select the existing individual worker entrypoint instead of `worker.mjs`, or
leave `VIDEO_WORKER_ENABLED=false`. No schema migration or user-data conversion
is part of this phase. To remove source changes, reverse only the Phase 1 diff;
do not reset the whole checkout. A patch reversing the API defaults is required
to return to its former fixed loopback behavior. No external state was changed.
