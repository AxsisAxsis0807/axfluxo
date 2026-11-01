# V0 検証記録

2026-11-01 JST。Node 24.19.0 / npm 11.9.0。ブランチ `feat/video-v0`、基準/再fetch済みmain `367fb02570b4782aa5f51e892718fc473b376c59`。

| 確認                    | 結果                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm ci --ignore-scripts | 成功、既存lockfile、依存追加なし                                                                                                                                                                                                  |
| npm run typecheck       | 成功                                                                                                                                                                                                                              |
| npm run lint            | 成功、警告0                                                                                                                                                                                                                       |
| npm test                | 16ファイル / 157件成功（既存140＋新規17）、skipなし                                                                                                                                                                               |
| 新規試験                | 長時間/不正整数、累積clip丸め、overflow/0frame、marker境界/重複/順序、clip重複、区間/overlap、名前数/危険名/名前衝突、未知version、固定参照必須、FNF保存除外、job/output整合、保存確認、developer DB v1、原本上書き拒否と旧値保持 |
| git diff --check        | 成功                                                                                                                                                                                                                              |
| 既存追跡ファイルの変更  | なし。README、既存schema、DB、runner、UI、backup、依存、CIに差分なし                                                                                                                                                              |
| PR #8競合確認           | APIで全12変更パスを確認、新規パスとの重複なし。意味上の接続境界はREADMEに記録                                                                                                                                                     |
| npm run build           | コンパイル成功後、NextのTypeScript設定取得で失敗（下記）                                                                                                                                                                          |

最初のネットワーク操作はsandbox内proxyへの接続で失敗。許可済みnetworkを実行コマンドに適用してnpm ciとgit fetch origin mainが成功。API/実fetchの両方でmain SHA一致を確認した。

Buildを単独再実行しても `Could not parse output from TypeScript's --showConfig.`。変更前mainのgit archiveをwork/へ展開し同じ依存で実行して同じ失敗を再現した。NextのrunTypeScriptCliを直接呼ぶとexitCode 0 / stdout空、通常の `tsc --showConfig` はJSONを返す。環境と既存Next CLIの出力取得経路に依存する問題であり、依存や既存設定を変更して回避していない。型チェック自体は独立に成功している。試験後に一時baselineは除去した。

UI・本番接続・media decoder・HTTP API・クラウドは今回追加していないため、それらのE2E/実機Safari/codec試験は実施していない。ネットワーク不要の合成media方針はfixtures.md。PR #8を統合した状態の実行試験は未実施。

main push、merge、deploy、クラウド作成、契約、本番migration、既存DB変更/削除/downgradeは行っていない。rollbackは追加機能を呼び出さず、新旧データを保持する。
