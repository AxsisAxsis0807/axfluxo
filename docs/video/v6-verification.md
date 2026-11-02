# V6 verification — 2026-11-02 JST

Base V5 `b4b4f70`、作業branch `feat/video-v6`。開始時に最新main `367fb02570b4782aa5f51e892718fc473b376c59`をfetch。AGENTS.mdなし。README/ADR/V0〜V5とopen PR #8を確認し、既存画像Workflow runner/Studioとの実装箇所の競合なし。Node24.19.0/npm11.9.0。契約、cloud作成、本番migration、push、merge、deployは実施していない。

| Gate                | 最終結果                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript / ESLint | 成功、warning 0                                                                                                                                  |
| 全unit/integration  | 30 files、286/286成功（V5既存273を維持、V6追加13）                                                                                               |
| 通常PostgreSQL18.6  | loopback専用`axfluxo_video_test_v6a`、V6統合7/7成功。複数接続の重複受付/冪等性、各rangeの実render/個別retryを含む                                |
| Chromium製品UI      | 全8/8成功（既存7＋FNF1）。最終FNF画面も単独再実行で成功                                                                                          |
| rollback E2E        | root desktop/mobile計8/8成功。FNF新入口OFF、5つのDBのversion/record維持、API非接続。旧preview/library/All Versions OFFも維持                     |
| 静的export          | root・`/axfluxo/`両方成功。最終root artifactを生成                                                                                               |
| server bundle       | API/render/probe独立build成功                                                                                                                    |
| Linux runtime       | 非root・network none・read-only・CPU2/RAM1GiB/PID128下で60frame全長copyと15frame cut/fallbackが成功。両方1080×1920/60fps・全decode/PTS/audio検証 |
| 互換性              | V0文書/時刻/snapshot schema、旧4DB＋developer DB v1定義、画像Studio/Workflow/backupとroot依存に差分なし。既存migration 001〜005も変更なし        |
| 差分/secret         | diff --check/Prettier成功。browser出力にDB/R2 secret設定名やnative canvas依存の混入なし                                                          |

Linux runtime試験は既存V4 imageを基盤に、最終V6 smoke bundle、既存native packageと固定Noto Sans JPをreadonly mountして実行した。V6 Dockerfileはfont/licenseの配布設定を追加したが、image全体の再build/publishは未実施。host ffmpeg7.1.5、image内ffmpeg5.1.9の両方で確認。

## 要件と障害試験

- 初期全長、現在位置から30秒/末尾までの追加、独立overlap、前後調整、長さを保つ全体移動、明示削除、同開始の作成順安定sort。ゼロframe/空譜面名/範囲外/ソート偽装/filename偽装を拒否。
- 同名、日本語、path traversal、Windows予約名、危険文字/control/bidi、長名を処理。元chartNameはそのまま、filenameだけ決定的な連番projectionとし、serverで再検証。
- 一括受付でjob/outbox/資源予約を同transactionへ作成。同owner/key同snapshotは同じbatch、別snapshot409。受付OFFはsnapshot/job/予約を残さず拒否。crop不適合も受付前に拒否。
- 全長はV4判定によるAAC copy、部分cutはAAC fallback。VFR 1frame目から15frame分の短区間を実renderし、正しいframe数/PTS/duration/audio sample数を検証。
- 赤→青の合成gameplayを使い、各rangeの先頭frame内容と開始順/filename対応を検証。固定見出し/日本語usernameの領域を先頭・中間・末尾frameで比較し、全編表示・fadeなしを確認。
- 3range中1つを失敗注入し、成功2つを保持して失敗rangeだけ明示retry。成功outputのID/hashが変わらず、最終3つが個別MP4になる。成功jobのretryは409。原本hashも不変。
- output accessで実際にsnapshotの各filenameをstorage adapterへ渡すことを確認。R2 RFC5987署名形式は既存試験を再実行。storage keyはfilenameではなくUUIDで、上書きAPIなし。
- preferencesはtemplate/usernameだけ。serverの未知key拒否、owner/membership/未認証/権限失効、If-Match409、別ownerのbatch/source参照拒否を確認。元sourceはV2のverified version/hash/全長を照合。
- 全IDB store/localStorageを読み、未送信chart sentinel、sourceDurationUs、creationOrder、tokenの保存がないことを確認。accepted snapshotだけがserverに残り、cloud projectへは書かない。
- Chromiumでは同開始/同名range→設定保存→誤cropの受付拒否→編集へ戻って修正→一括受付→tab終了→新tabでpreferencesのみ復帰→batchの明示確認→source再選択時は全長1range/空名、を検証。ページ終了時のjob cancel送信なし。
- 既存V3のpinch/pointercancel/IME/横向き/背景復帰・署名URL更新・結合clip、V2 upload再開、V1 token更新失敗の表示を再実行し、全て成功。

## 未検証・運用境界

R2実接続、実機Safari、WebKit自動実行、OSによる実タブ破棄、複数の物理端末、大容量/長時間実render、特殊rotation、あらゆるUnicode glyphの表示は未検証。WebKitの配布host制限は前フェーズと同じで、今回実行成功とはしていない。browserのtab closeは実行したがOS killとは区別する。

既存versionに表示寸法の追加metadataがない場合はraw寸法/未検証warningを表示し、immutable原本versionを書き換えない。workerは実sourceをprobeし直す。通常presetと異なる寸法に対し固定scaleを黙って合わせない。live previewのCSS縮小表示について最終MP4との画素完全一致は主張しない。

font未配置/改変はtyped error、資源不足はV4の保留方針。受付済みsnapshotはimmutableで、retryに後から変更したusername/templateを混入させない。rollbackは入口/新規V6受付OFFだけで、job/output/checkpoint/原本/preferencesを保持する。

006 SQLはローカル専用test DBだけに適用。既存test DBも維持し、試験serverは終了時に停止。生成evidence（git対象外）: `work/v6-unit.log`、`v6-session-tests.log`、`v6-native.log`、`v6-browser-all.log`、`v6-browser.log`、`v6-rollback-e2e.log`、`v6-typecheck.log`、`v6-lint.log`、`v6-build-root.log`、`v6-build-base.log`、`v6-build-api.log`、`v6-build-render.log`、`v6-build-probe.log`、`v6-docker-smoke.log`。
