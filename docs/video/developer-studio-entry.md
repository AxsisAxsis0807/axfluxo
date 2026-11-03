# Developer Studio の入口

Workflow と旧 Studio の左サイドバーにあるアカウントの直下に Developer Studio を表示する。表示判定は既存 Supabase セッションを使った `GET /v1/developer/me` の成功のみ。ユーザーの metadata やフロントエンドのフラグは開発者認可に使わない。

`/developer/studio/` から All Versions Video Maker (`/developer/all-versions/`) と FNF Showcase Maker (`/developer/fnf-showcase/`) を同じタブで開く。3画面は直接アクセスでも認可確認前に制作 UI をマウントしない。ログアウト、認証変更、画面復帰、前面での60秒ごとの確認で失効を反映する。サーバー API は従来どおり JWT の署名検証と developer_memberships の active / expires_at を確認する。静的エクスポートの HTML 自体には秘密情報を含めない。

実行環境には既存の `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`NEXT_PUBLIC_VIDEO_API_ORIGIN` が必要。GitHub Pages / CI のビルドでは、同名の GitHub リポジトリ変数 `NEXT_PUBLIC_VIDEO_API_ORIGIN` を渡す。公開 origin のみを設定し、鍵は含めない。開発者権限は管理者がサーバー DB で付与する。入口のために一般ユーザーへ権限を自動付与しない。これらの専用画面からは古い Studio / 個別ツールの表示フラグに依存せずツールを開ける。

両ツールの標準書き出しは Canvas captureStream + Web Audio + MediaRecorder による端末内エンコード。原素材の署名 URL と既存の文字 PNG API を使い、動画レンダー job は作成しない。原素材配信元には CORS 設定が必要。書き出し時も開発者権限を再確認する。既存サーバー書き出しは「サーバーで書き出す」内に残す。

MP4 対応端末では MP4、それ以外は WebM を実際の MIME に合わせた拡張子で出力する。全端末での H.264 / AAC / 固定フレームレート保証は MediaRecorder の提供範囲に依存する。非対応端末ではエラーを表示し、自動でサーバー処理に切り替えない。

10分処理・4分休憩は初期 ON。素材の処理時間をツール内の連続する出力間でも累積し、600秒ごとに素材の再生と recorder を一時停止し、240秒後に再開する。休憩中も中止できる。画面非表示やコンポーネント離脱時には処理を中止し、不完全な動画を保存候補にしない。完了済みの各ファイルはそのまま保存できる。Safari は前面で使用し、OS による画面ロックを避ける。

検証には既存のサーバー認可テストと `developer-entry.spec.ts`（開発者/一般ユーザーと直接 URL）および `local-encode.spec.ts`（trimした2区間を結合し、音声・動画の両 stream と出力時間を ffprobe で確認）を使用する。実機 iPhone Safari では長時間処理・休憩復帰・共有/ファイル保存を別途確認する。
