# iPhoneで使うための公開手順

公開設定更新: 2026-10-23 JST。公開成功はActionsのdeploy・verify成功と公開URLの確認で判断してください。

初期版はサーバーAPI不要のNext静的exportです。`npm run build`で`out/`を生成します。IndexedDBはアクセスするoriginごとに分かれ、公開先やドメインを変更しても作品は自動移行しません。変更前に完全バックアップを保存してください。

## 推奨: GitHub Pages（追加アカウント不要）

対象はpublic repositoryなので、GitHub Pagesの静的ホスティングを候補にできます。Nodeサーバー、DB、クラウド鍵は不要です。

`.github/workflows/pages.yml` はmainへのPushと手動実行で公開します。PRではbuildだけ実行し、公開しません。型・Lint・単体テスト・静的build・本番サブパスでのデスクトップ/iPhoneサイズChromium E2Eが成功したartifactだけを公開します。deploy後は公開HTTPS URLへ同じE2Eを実行します。既存CIはルートパスを引き続き検証します。

Pages初回設定（iPhone SafariでGitHubにログインして操作可能。項目が見えない場合はSafariのページメニューからデスクトップ用Webサイトを表示）:

1. GitHubのリポジトリ Settings → Pages → Build and deployment → Sourceを **GitHub Actions** にする。
2. Actionsの利用を許可し、必要なら `github-pages` environmentの承認ルールを設定する。
3. mainにMerge済みの「Publish GitHub Pages」を **Run workflow** → branch: main → **Run workflow** で実行する。以後はmainへのPush/Mergeで自動実行する。
4. deploy jobが返すURLを確認する。標準構成の予定URLは `https://axsisaxsis0807.github.io/axfluxo/` 。**これは未公開の予定値で、稼働確認済みURLではありません。**
5. iPhone SafariでHTTPS URLを開き、画像選択・日本語入力・ピンチ・回転・PNG/JPEG保存・ZIP復元を実機確認する。

ローカルでは `NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build` と専用の静的サーバーで、iPhoneサイズの画面・同梱フォント・サンプル作品の1080×1080 PNG出力を確認済み（HTTP/JavaScriptエラー0）。これは公開ホストの稼働確認ではない。

準備済み設定:

- build時 `NEXT_PUBLIC_BASE_PATH=/axfluxo`。NextのbasePathに加え、出力CSSの同梱フォント参照にもprefixを付けるpostbuildを用意した。
- `out/.nojekyll` を生成する。
- 全体は `contents: read`、deploy jobだけ `pages: write` / `id-token: write` を使用。`github-pages` environment。
- Nodeは`.nvmrc`と同じ24.19.0。
- 公開後も制作データは各利用者の端末内。クラウド同期や自動投稿は追加されない。

現時点で確認できた権限: GitHub連携は対象repoのadmin・push権限を返した。実際のgit pushも成功した。

未確認／公開時に必要な設定: Pages sourceの現在値、Actions/Environment制限、Pages有効化・デプロイ権限の実際の実行可否、独自ドメインを使う場合のDNS管理権限。これらは今回変更していない。追加の有料契約や秘密鍵は標準Pages案には不要。

## 代替: Vercel / Cloudflare Pages / その他静的ホスト

リポジトリを所有者アカウントから連携し、build command `npm run build`、出力`out`、Node24を指定する。ルートドメインなら`NEXT_PUBLIC_BASE_PATH`は空。Next専用プリセットより静的サイトとして扱う構成を明示する。プロジェクト作成・GitHub Appのrepoアクセス許可・プラン確認が必要。今回はアカウント接続やプロジェクト作成を行っていない。

将来認証・API・SNS連携を追加する段階では、静的Pagesだけでは足りず、サーバー実行基盤・秘密情報・OAuth redirect URL等を別途設計する。

## 参照と調査制限

- Next静的export: https://nextjs.org/docs/app/guides/static-exports
- Next basePath: https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath
- Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages
- ActionsによるPages: https://github.com/actions/deploy-pages

本環境ではnextjs.org / docs.github.comへの直接HTTP取得がネットワーク方針で拒否された。依存パッケージmetadataとNextの実際のstatic buildで設定を確認し、公式GitHubリポジトリも参照できる。外部ホストへの公開結果やアカウントの設定値を検証済みとはしていない。


## 今回の環境制約と検証の見方

作業開始時、mainは588227dafd06cae7a68961b4bd8d3f3c0584ba62、PR #1は同コミットへMerge済みとGitHub APIで再確認。Next.jsは16.4.2。既存mainのCI（39864066324）は全検証成功。

ローカルでgit fetch、npm ci、型チェック、Lint、単体テスト29件、/axfluxo/向け静的buildを実行し成功しました。初回はサンドボックスのネットワーク権限不足で依存導入が失敗しましたが、必要な権限を指定して解消しました。公開先ドメインとPages設定APIへの直接接続は別途ネットワーク方針で拒否されています。ローカルのデスクトップ/iPhone 13サイズChromium E2Eも12件成功。PR #2のCI（39917696067）とPages用build（39917696115）も成功しました。main Merge後はdeployと公開URLのverifyを別途確認してください。

GitHub連携はadmin/push権限を返しますが、Pages設定変更・workflow手動起動APIはこの連携のツールにありません。Pages設定の現在値もこの連携では取得できません。Source設定が必要な場合は上記の画面操作で行ってください。configure-pagesで「Get Pages site failed」等になる場合はSourceとActions許可を確認し、設定後にworkflowを再実行します。deploy成功でもverify失敗なら公開後動作確認は完了ではありません。

## iPhone実機Safariの確認

1. Actionsのdeployが返したHTTPS URLを通常タブで開きます。ホームが崩れず、日本語が表示されることを確認します。
2. 新しいプロジェクトを作成し、JPEG/PNGの写真を追加。HEICは未対応なので必要なら写真をJPEG/PNGに変換します。
3. 設定パネルから中央固定クロップを開き、1指移動・2指ピンチ・回転・適用/キャンセルを確認します。文字と図形、Undo/Redoも操作します。
4. 「この端末に保存済み」を待って再読み込みし、作品を開いて画像・文字・編集状態が復元されることを確認します。
5. 書き出しでPNG/JPEGのプレビューを作り「ファイルを保存」。Safariのダウンロード一覧や「ファイル」アプリで開きます。複数ページのZIPも確認します。
6. バックアップZIPを保存し、ホームのバックアップ取込で別作品として画像込みで復元できることを確認します。端末を回転させても設定・ページ・レイヤーが操作できることを確認します。

ActionsのmobileはiPhone 13サイズのChromiumです。iPhone実機Safari、IME、共有シート、端末容量限界の検証とは区別してください。IndexedDBはorigin単位なのでlocalhostの作品は公開先へ自動移行しません。バックアップZIPで移行してください。
