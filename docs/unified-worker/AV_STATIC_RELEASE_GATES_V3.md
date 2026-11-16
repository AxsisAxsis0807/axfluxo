# 静止画合成 Release Gates v3

**HOLD: 本番Cloud受付OFF、STATIC_COMPOSITEデフォルトOFFを維持。マージ・デプロイ・公開・新PR・Blitz設定変更は未承認であり実施しない。** 今回のbranch pushだけが許可範囲。

[Blitz公式limits](https://blitz.cloud/docs/limits/)を2026-11-16に再確認（文書更新2026-11-12）。Smallの公表上限512MB/0.5CPU、予約128MB/0.05CPU。Medium上限1GB/1CPU。実Blitz cgroup byte設定は未確認。decimal512,000,000 Bを第一基準、536,870,912 Bを参考値として別試験した。今回どちらもOOM。1GB比較は要求1,000,000,000 Bに対して実memory.max999,997,440 B（4KiB page切り下げ、2,560 B厳しい）。課金・trial・アカウント枠の操作なし。

| Gate | 状態 | 必要な証拠 |
|---|---|---|
| 正しい静止経路実行 | PASS（B/E限定） | PNG生成→使用→静止segment完了、動的fade fallback、再利用 |
| 512MB反復成功 | HOLD | OFF/ON各2回OOM。静止経路へ未到達、成功名を付けない |
| 512MiB反復成功 | HOLD | 同じくOOM、Small対応としない |
| 1GB単体5秒 | PASS（予備） | 各2回完成、品質hash一致。実Medium保証ではない |
| 複数タイトル/Reference品質 | PASS（2GiB合成） | 完全decode/PTS/音声一致、時計の指定frame検査 |
| 実Worker静止ON/本番image | PARTIAL | 1秒/12-frame segment統合はPASS。512MB統合資源測定・production imageは未実施 |
| 強制停止/復旧 | PARTIAL | 単体の実停止・再生成、既存native DB tests。静止ONのupload失敗/checkpoint再利用smokeはPASS、PNG各段階SIGKILL統合は未完了 |
| 30秒/連続/0.05CPU | PARTIAL | 1GB単体30秒のOFF/ON各1回は完成。Small長尺・長い連続job・実Worker長尺・0.05CPUは未検証 |

本検証に「512MB短時間合成試験PASS」は付けられない。Small向けPhase Fは短時間OOMのため進めない。1GB予備成功へ制限を上げて512MB成功と読み替えない。

本番化前には、凍結したsource/image/encoder/inputと実プラットフォームのmemory.max/cpu.max/swap値を照合し、Worker/RLS/owner/fencing/lease/cancel/retry/ready-only publication/checkpoint互換性を静止ONで確認する。既存Generic RenderはONでplan hashへstatic-base-v1を追加する仕様を保持。encoder/renderer identityやlookahead変更を同じcheckpointとして流用しない。

改善案はフェード区間のピーク解析→バッファ/寿命/同時実行の最小候補→同一条件OFF/ON再比較を優先。画質/認証/復旧を犠牲にしない。本番仕様の大変更・encoder設定変更は独立した提案と互換評価に分離する。
