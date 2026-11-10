# 2026-11-10 ローカル検証記録

取得時と完了前の `origin test/blitz-connection-probe` はともに
`0490705c90ced2e1d7f7bef246681bd43e470bc9`。着手前の作業差分なし。
commit/push/Blitz操作/外部DB操作はしていない。

- Node 24.19.0 / PGlite 0.5.14: **5 tests passed**。
- PostgreSQL 17（ローカルDocker、NOSUPERUSER/NOCREATEDB/NOCREATEROLEのprobe login）:
  **5 tests passed**。同時初期化2件も同一schema/runで成功。
- 既存テーブル入りDBの拒否と値の保持、偽の同名schema拒否、同run初期化の再実行、
  別run拒否、current_database不一致拒否、開始再押下と期限切れ後の延長拒否を確認。
- 内部HMACの未認証/不正署名/古い署名/再送拒否、HTTP試験3回上限を確認。
- 共有あり/共有なし、worker boot重複抑止、API listener停止中のworker DB書込みを確認。
  providerの自動sleepは試験していない。
- DBなしでAPI起動、起動時DB問い合わせなし、未認証設定非公開、
  認証後DATABASE_URL_MISSING表示を確認。
- storage失敗が固定コードになり、実pathを出さないことを確認。
- Chromium（390×844、touch/mobile設定、ローカルPostgreSQL）:
  provider生成名を想定した `provider_generated_42` で、認証→設定状態→初期化→開始→
  再開始時の期限一致→共有marker作成→worker未設定表示→report→JSON downloadを確認。
  横スクロールなし、pageerrorなし。実機iPhone/Safariではない。
- API/worker両Docker imageをbuild。新規lifecycle.mjs/SQL/UIを同梱。
  network none / memory 128MB / pids 32 / UID1000で、DBなし起動とhealthを確認。
- `git diff --check` 成功。変更は `server/connection-probe/` のみ。
  npm依存とlockfileは変更なし。本体のlint/typecheckは試験専用mjsを検査しないため流用しない。

Blitz上のDB TLS、provider login権限、Parts追加、内部経路、volume共有、永続性、
自動sleep、free残期限は未確認。READMEの画面確認ゲートが残る。
