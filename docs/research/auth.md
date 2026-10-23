# Supabaseメール認証

2026-10-24 JST: リモート全3ブランチ、PR head refs #1/#2、取得可能な全9コミットを調査したが、以前のメール認証実装は見つからなかったため再実装。

アカウントボタンから登録、ログイン、確認メール再送、パスワード再設定、ログアウト。確認メールと再設定メールは静的ページのルート（本番は https://axsisaxsis0807.github.io/axfluxo/）へ戻る。Supabaseの許可リダイレクトURLにもこの末尾スラッシュ付きURLを設定する。Email provider / Confirm Email を有効にする。標準メールの送信上限や迷惑メールフォルダも確認する。

認証には公式supabase-js SDKとPublishable Keyのみを使用。セッションは専用localStorageキー `axfluxo-auth` に保存。パスワードをアプリ側で保存しない。暗黙的コールバックのURL資格情報の処理、トークン更新、複数タブのセッション通知はSDKが担当。ログアウトはこの端末の認証セッションを終了する。IndexedDBのスキーマ・DB名・原本・作品・テンプレート・バックアップ形式は変更しない。ログイン前の作品も同じ端末の共有ワークスペースに残る。アカウント別データ分離やクラウド同期は行わない。共有端末での作品の扱いには注意する。

## ビルド時の公開設定

ローカルは `.env.example` を `.env.local` にコピーしてPublishable Key実値を指定。未設定の場合はゲスト編集が利用可能。

GitHub ActionsのCI/Pages両workflowで `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` をビルド時に渡す。Repository Variablesがあれば優先する。Variables APIは連携のアクセス制限によりGET/POSTともForbiddenだったため、ユーザーから提供された**公開用**URLとPublishable Keyをworkflow envの既定値として使用する。Secret Key・Service Role Keyは使用しない。

所有者によるVariables設定（任意。公開用既定値があるので公開を妨げない）:

1. リポジトリ Settings → Secrets and variables → Actions → Variables → New repository variable。
2. `NEXT_PUBLIC_SUPABASE_URL` = `https://nbyigfqkweodzlhwdryz.supabase.co`。
3. `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = 今回提供した `sb_publishable_` で始まるキー。
4. キー変更後はPublish GitHub Pages workflowをmainで再実行。ブラウザ向け設定は静的JSに組み込まれるため再ビルドが必要。

## 検証の範囲

単体テスト: 公開キーとHTTPS URLの検証、SSRでの未初期化、日本語エラー。
ブラウザテスト: Supabase APIをモックし、登録・確認待ち・ログイン・再読込時セッション・ログアウト・ゲスト作品保持・メール再送制限・パスワード再設定・期限切れリンク。テストメールは実送信しない。
既存の画像取込・クロップ・書き出し・ZIP復元・自動保存・テンプレート・複数タブ競合のE2Eも継続する。
本番workflowではread-onlyの `/auth/v1/settings` をPublishable Keyで取得し、Email provider / Confirm Emailを確認する。
実受信箱で確認リンクを開く一連の実メール操作、実機Safariは別途手動確認が必要。

ローカル検証結果: typecheck / lint / 単体テスト32件 / `/axfluxo/`公開設定付き静的build / デスクトップ・iPhone13サイズChromium E2E全22件が成功。npm audit --omit=devは既知脆弱性0件。モバイル幅390pxでページ横はみ出しなしを確認。
