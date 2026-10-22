# iPhoneで使うための公開手順

調査・設定準備: 2026-10-23 JST。**今回は公開デプロイしていません。**

初期版はサーバーAPI不要のNext静的exportです。`npm run build`で`out/`を生成します。IndexedDBはアクセスするoriginごとに分かれ、公開先やドメインを変更しても作品は自動移行しません。変更前に完全バックアップを保存してください。

## 推奨: GitHub Pages（追加アカウント不要）

対象はpublic repositoryなので、GitHub Pagesの静的ホスティングを候補にできます。Nodeサーバー、DB、クラウド鍵は不要です。

用意した `.github/workflows/pages.yml` は **workflow_dispatchのみ** で、Push/Mergeだけでは公開しません。mainソースを検証・buildして、Pages artifactを公開する手動workflowです。

所有者が公開を決めた後の操作:

1. GitHubのリポジトリ Settings → Pages → Build and deployment → Sourceを **GitHub Actions** にする。
2. Actionsの利用を許可し、必要なら `github-pages` environmentの承認ルールを設定する。
3. mainにMerge済みの「Publish GitHub Pages (manual)」を **Run workflow** で実行する。
4. deploy jobが返すURLを確認する。標準構成の予定URLは `https://axsisaxsis0807.github.io/axfluxo/` 。**これは未公開の予定値で、稼働確認済みURLではありません。**
5. iPhone SafariでHTTPS URLを開き、画像選択・日本語入力・ピンチ・回転・PNG/JPEG保存・ZIP復元を実機確認する。

ローカルでは `NEXT_PUBLIC_BASE_PATH=/axfluxo npm run build` と専用の静的サーバーで、iPhoneサイズの画面・同梱フォント・サンプル作品の1080×1080 PNG出力を確認済み（HTTP/JavaScriptエラー0）。これは公開ホストの稼働確認ではない。

準備済み設定:

- build時 `NEXT_PUBLIC_BASE_PATH=/axfluxo`。NextのbasePathに加え、出力CSSの同梱フォント参照にもprefixを付けるpostbuildを用意した。
- `out/.nojekyll` を生成する。
- workflowの `contents: read` / `pages: write` / `id-token: write`、`github-pages` environment。
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
