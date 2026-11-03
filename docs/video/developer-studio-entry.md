# Developer Studio：動画APIに依存しない開発者認可

## PR #12の公開サイトで入口が見えない原因

`338c5373321ba943d12b170e9543e05fb586766a`（PR #12）は main に反映済み。
[本番Pages実行41611444877](https://github.com/AxsisAxsis0807/axfluxo/actions/runs/41611444877) の build / deploy / verify はすべて成功した。
同じビルドのログでは `NEXT_PUBLIC_VIDEO_API_ORIGIN` が空だった。

PR #12の `DeveloperAccess.tsx` は、この変数がない場合、Supabaseにログイン済みでも権限照会をせず入口を隠していた。設定されていても、動画APIの JWT 検証と独立DBの `axfluxo_video.developer_memberships` に有効な行が必要だった。Supabaseへのログインは開発者登録ではない。GitHub所有者であることもSupabaseの開発者権限にはならない。

現在ログイン中のブラウザーセッションと本番DBの管理接続はこの作業環境にないため、そのアカウントの登録状態は未確認。GitHubのメールアドレスや表示名からSupabaseユーザーを推定して登録してはならない。

## 今回の認可

既存Supabaseプロジェクトの `public.axfluxo_developer_access()` RPC が唯一の入口判定になる。動画APIは不要。

- SupabaseがJWTを検証し、引数なしの関数内で `auth.uid()` を取得する。
- 管理者だけが変更できる非公開schemaの `axfluxo_access.developer_memberships` で本人の `user_id`、`active`、`expires_at` を確認する。
- `anon` は実行不可。`authenticated` はRPC実行のみで、会員テーブルの参照・登録・更新は不可。RLS有効、利用者向けpolicyなし。関数は `SECURITY DEFINER`、空のsearch_pathと修飾済みの参照を使う。
- `user_metadata`、自己申告、公開メールallowlist、localStorageのrole、公開環境変数で開発者を決めない。
- 正常応答でも本人IDの一致と有効期間を検証する。会員なし・失効・期限切れ・RPC未設定・通信失敗では閉じる。RPCの応答を永続キャッシュしない。
- 45秒ごと、認証変更、画面復帰に再確認。応答の有効期間は最大60秒で、再確認できなければ閉じる。ログアウトや別ユーザーへの切替でも閉じる。書き出し開始前にも再確認する。

一般ユーザーにはサイドバー入口を表示せず、専用URLへの直接アクセスでも編集UIをマウントしない。GitHub Pagesは静的配信なので、HTML/JavaScriptそのもののダウンロードを認可する仕組みではない。保護対象の会員情報はSupabase側で制限する。

## 管理者による設定・現在のアカウントの正規登録

この手順の実行には既存Supabaseプロジェクトの管理権限が必要。本修正で本番DBへの適用や会員付与は自動実行しない。

1. AxFluxoがログイン先に使っているSupabaseプロジェクトを開く。現行公開設定のproject refは `nbyigfqkweodzlhwdryz`。新しいプロジェクトを作らない。
2. Authentication → Usersで、AxFluxoにログインしている本人の確認済みメールとユーザーID（UUID）を確認する。修正後のAxFluxoの「アカウント」にも本人IDを表示する。IDを他人のものと取り違えない。
3. 同じプロジェクトのSQL Editorで [認可migration](../../supabase/migrations/202611030001_developer_access.sql) をDB管理者として実行する。既存の認証・制作DBや動画サーバーmigrationは変更しない。公開schemaには引数なしRPCだけを追加する。
4. 以下の `YOUR_CONFIRMED_USER_UUID` を確認した本人IDに置き換えて管理者として実行する。JWTやservice role鍵をフロントエンド・GitHub変数・チャットに貼らない。

```sql
DO $$
DECLARE target_user uuid := 'YOUR_CONFIRMED_USER_UUID';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = target_user AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '確認済みの本人アカウントを指定してください';
  END IF;
  INSERT INTO axfluxo_access.developer_memberships(user_id, active, expires_at)
  VALUES (target_user, true, NULL)
  ON CONFLICT (user_id) DO UPDATE SET active = true, expires_at = NULL;
END $$;
```

5. 修正のPRをmainに反映し、GitHub Pagesのbuild・deploy・verify成功を確認する。`NEXT_PUBLIC_VIDEO_API_ORIGIN` は未設定のままでよい。既存の `NEXT_PUBLIC_SUPABASE_URL` とpublishable keyを使う。
6. 同じアカウントでサイトを再読み込みする。「アカウント」の直下のDeveloper Studioから両ツールを開き、端末の素材を選択する。一般アカウントでは入口と専用画面を開けないことも確認する。

管理者による登録確認・失効・期限設定：

```sql
-- 必ず上の本人IDに置き換える。
SELECT user_id, active, expires_at
FROM axfluxo_access.developer_memberships
WHERE user_id = 'YOUR_CONFIRMED_USER_UUID'::uuid;

-- 失効。ブラウザーでは次回確認（前面なら通常45秒以内、最大60秒）で閉じる。
UPDATE axfluxo_access.developer_memberships SET active = false
WHERE user_id = 'YOUR_CONFIRMED_USER_UUID'::uuid;

-- 期間限定にする場合（例）。
UPDATE axfluxo_access.developer_memberships
SET active = true, expires_at = now() + interval '30 days'
WHERE user_id = 'YOUR_CONFIRMED_USER_UUID'::uuid;
```

登録IDの誤り、異なるSupabaseプロジェクト、失効・期限切れ、未適用migrationは、動画APIを用意しても解決しない。一般ユーザーへ権限を一括付与して回避しない。

## 端末内エンコード

専用画面の標準はローカル制作ツール。動画APIを設定していても標準は変わらない。

- All Versions Video Maker：端末の音声/動画を順序付きで選択、区間指定、素材内の秒数でversion境界を入力、version名を1行ずつ入力、端末のcover画像を指定。結合した音声とcover・名前を端末内で動画にする。
- FNF Showcase Maker：端末動画を選択、cropとusername、複数rangeの開始/終了・譜面名を入力。rangeごとに端末内で動画化する。
- Canvas + Web Audio + MediaRecorderを使用し、素材や動画をアップロードしない。文字も端末内描画。標準レイアウトは端末フォントを使い、旧クラウドツールの固定フォント・pixel一致を保証する経路ではない。
- 10分処理・4分休憩は初期ON。録画・素材再生を一時停止し、休憩時間を完成動画に含めない。複数出力間も処理時間を累積。中止、背景移動、画面離脱にも対応する。
- 音声は録画用のWeb Audio出力に接続し、要素のmuteで無音にならないようにする。Safariで追加の再生許可が必要な場合はタップで再開する。音声トラックの有無だけでなく、合成音の波形が無音でないことも自動検証する。
- 対応端末はMP4、その他の対応端末はWebM。非対応ブラウザーでは理由を表示し出力しない。Linux WebKitでエンコーダーがない場合とiPhone Safariの実機は区別する。
- ローカル編集内容は画面のメモリー内。移動や再読み込み前に出力を保存する。iPhone Safariは前面で操作する。実機での長時間処理と保存は別途確認する。

既存のクラウド素材・サーバー書き出しは、動画APIが設定されている場合の追加操作として残す。そちらは引き続き動画API側のJWT / `axfluxo_video.developer_memberships` / owner照合で保護する。新しいローカル用登録はクラウド権限を自動付与しない。既存のWorkflow、画像Studio、4つの制作DB、動画プロジェクトDB、バックアップ形式は変更しない。

## 公開ビルドの確認

今回からpostbuildで `/axfluxo/build-info.json` に公開コミットSHAとビルド日時だけを出す。GitHub Actionsの対象SHAと一致するか確認できる。秘密情報は含めない。

- サイトが古い：Pagesのdeploy/verify結果とbuild-infoのSHAを確認する。
- 「確認機能が未設定」：同じSupabaseプロジェクトにmigrationを適用する。
- 「開発者登録が必要」：本人ID・active・expires_atを管理者が確認する。
- 「ログインしてください」：既存アカウントでログインし直す。
- 通信失敗：Supabaseへの接続を復旧する。認可を省略する回避策は用意しない。
