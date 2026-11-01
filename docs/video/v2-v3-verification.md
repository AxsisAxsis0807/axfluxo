# V2/V3 最終検証記録

2026-11-01 JST。Node 24.19.0/npm 11.9.0。mainは各phase開始時のAPI/fetchで `367fb02570b4782aa5f51e892718fc473b376c59`。AGENTS.mdなし。V1 `934a2ab` → V2 `1329038` → branch `feat/video-v3`。未マージPR #8の固定入力/Studio復帰は変更しない。設計・設定・rollbackは[v2.md](v2.md)/[v3.md](v3.md)。

| 確認                              | 結果                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm test                          | 24ファイル / 222件成功。既存/V0/V1の182件を維持し、skip/削除なし                                                                                                 |
| npm run typecheck / lint          | 成功、Lint警告0                                                                                                                                                  |
| V2 API統合（PGlite）              | 18件成功。実PostgreSQLエンジン、実SHA/ffprobe、mock multipart provider                                                                                           |
| V2 API統合（通常PostgreSQL 18.6） | 同じ18件成功、複数connectionで容量予約競合・RLS・worker roleを検証                                                                                               |
| V2 browser単体                    | 6件成功。File.slice/最大2MiB hash読取り、再選択hash、owner別resume、署名失効、中断                                                                               |
| R2 SDK/config                     | 2件成功。offline presignのContent-MD5束縛、300秒part/60秒access、既定受付停止                                                                                    |
| V3時刻/保存                       | 8件成功。長時間・MAX_SAFE_INTEGER、有理数4fps、clip連結、FNF重複/移動、media時計のseek/URL更新、文書CASと未送信値除外                                            |
| V3派生物（PGlite）                | 6件成功。全長proxy、各fpsの全frame PTS（差2µs以内）、VFR、回転、3解像度waveform、queue/認可/予算/不変原本                                                        |
| V3派生物（通常PostgreSQL 18.6）   | 同じ6件成功。専用空DB、本番postgresDatabase/probe role使用                                                                                                       |
| 共通browser UI Chromium           | 6/6。再選択/背景/reload、1frame seek、再認可位置復帰、trim保存、FNF重複と全体移動/試聴、pinch handle取消/pointercancel/IME/横向き、clip cut/marker、認証更新失敗 |
| root E2E                          | 認証10＋診断2＋preview OFF2＋cloud未設定2＝16/16、PC/スマホChromium                                                                                              |
| /axfluxo/ E2E                     | 同じ対象16/16、PC/スマホChromium                                                                                                                                 |
| /axfluxo/ 静的export              | 成功。追加画面のindex/公開root linkを維持                                                                                                                        |
| root静的export                    | 成功、追加画面も静的route。Studio rendererを置換しない                                                                                                           |
| 独立API/probe/derivatives build   | 成功。秘密はruntime設定のみで静的frontendへ入れない                                                                                                              |
| 既存契約のdiff                    | Studio/editor renderer、LibraryRef、画像上限、4DB、旧backup、Supabase auth、Next設定に差分なし                                                                   |
| frontend bundle境界               | R2 secret/DB URL/server SDK/SQL workerの混入なし                                                                                                                 |
| git diff --check                  | 成功                                                                                                                                                             |

V2のネット切断試験は17MiBを超える同じFileを実API client経由で一部転送後に切断し、reload相当のresume hintから同じbytesを再選択した。ListParts/part SHA/MD5を再照合し、未完了partだけを送り、workerがstream SHA-256を再計算して元hash一致を確認した。名前/lastModifiedが違っても同bytesは認め、同名同sizeの別bytesは拒否する。別ownerはupload/version/asset/folder/URL発行へアクセスできず、確定原本はabort/期限回収/ゴミ箱で消えない。

全media fixtureはffmpeg lavfiからnetworkなしで生成した。回転fixtureはMP4 tkhdの標準display matrixを明示し、ffmpegのrotate tag書込差に依存しない。proxyは元のframe数・PTS間隔を保持し、full-lengthのまま別keyへ生成する。原本のbytes/hash/versionは維持する。PCMは逐次集約し、browserではpeak metadata以外の全量ArrayBuffer/WebAudio decode/frame cacheを使わない。

## 明確に未検証のもの

- WebKit: 自動試験のproject/ケースは登録済み。環境の公式browser配布先は許可host外で403となり、導入・実行できなかった（V1で確認、現在も同じnetwork policy）。ChromiumのiPhone viewportをWebKit/Safari成功とは数えない。
- 実機Safari: OS背景化/メモリー回収によるtab破棄、実IME、iOS codec/decoder、実長尺seekは未実施。合成visibilityとpage reloadは論理回復の試験であり実機保証ではない。
- R2 live: bucket/契約/資格情報を作成せず、接続もしていない。private設定、CORS、実providerのListParts/ETag/Range/lifecycleは既存環境を使う別の承認済み検証が必要。
- 最大容量/長尺: 整数時刻とmock media clockは100時間等を確認したが、100時間実mediaやiPhone最大メモリー/GPU/worker CPU/diskは計測していない。現在素材以外のwaveformは遅延取得となる。
- 複数host障害やworker hard kill、partial derivativeの運用精算は未検証。失敗候補・予約は保守的に保持し、原本の自動削除はしない。

既定sandboxではbrowser socket/spawnSyncに制限があるため、提供されたnetwork権限を適用したコマンドでbrowser/build/installを実行した。network mediaへのfallbackや検証のskip/期待値緩和はない。通常PostgreSQLはwork配下の試験専用loopback clusterで実行し、終了時に停止するがdataは保持する。

本番migration、cloud作成、契約、push、merge、deployなし。rollbackは新upload/preview入口と新規生成の停止。追加table、確定原本、派生物、文書、既存データを保持する。
