# All Versions fade memory v4 Release Gates

**HOLD。本番Cloud受付・静止画合成デフォルトOFF維持。** v4は隔離診断・自己監査であり、Blitz Small/Mediumの実資源、無料枠適格性、実本番imageを保証しない。

- 512MBは512,000,000 B。512MiBは536,870,912 B。無料枠の予約量を実行上限と同一視しない。
- 512MB PASSには、実memory.max ≤512,000,000 B、swap.max=0、OOM増分0、ジョブ完成、品質PASS、同一条件の独立反復2回以上が必要。短時間だけの成功を本番承認としない。
- 最初のdynamic segmentでOOMした静止ONケースはジョブ失敗の証拠として有効だが、静止合成性能としてINVALID_TEST。
- 低解像度・低fps・CRF/preset/lookahead変更・フェード/時計/音声/セグメント仕様変更で成立させない。
- PNG cropや入力loop変更は、完全な実レンダー経路の全フレーム・PTS・PCM・境界/Reference確認と、PNG生成を含む全ジョブピーク測定後に評価する。
- checkpoint/owner/lease/fencing/公開/キャンセル契約、破損成果物拒否、SIGKILL復旧を維持する。単体再生成・Mock・実DB・実ストレージを分ける。
- 1GBへの移行は、現行の予備成功だけでは承認しない。実Worker/本番imageで1GBの実memory.max・CPU/swap・同時ジョブ数を確認し、長期連続・複数タイトル/Reference・復旧・ディスク上限・容量余裕を再評価する。実プラットフォームの課金/無料適格性は別途承認対象。

PR #34/#35はopen/draft/merged=falseを読み取り確認。main・既存PRブランチ・本番DB・ユーザーデータ・Blitz設定・課金/有料trial・公開/デプロイを操作しない。新PRも作成しない。許可されたv4隔離ブランチのコミット/pushのみ。

| Gate | v4判定 | 実測/制約 |
|---|---|---|
| baseline先頭OOM再現 | PASS（再現） | 512MB OFF/ON各2回、segment0 SIGKILL/oom_kill+1 |
| 候補Aのみ512MB | HOLD | fade完了後、static segment1で2回OOM |
| 候補B・5秒512MB | 限定PASS | 独立3回、全品質一致、静止3segment完了、OOM増分0。ただしpeakは上限付近 |
| 候補B・15秒512MB | HOLD | 2タイトル目segment5でOOM。これ以上の512MB長尺試験を停止 |
| 512MiB | PARTIAL | baseline ONはOOM、Bは5秒1回完成。decimal512MB長尺失敗の代用にしない |
| 候補B・1GB | 予備PASS | 5秒2回、15秒/Reference/30秒各1回完成。実Worker制限下ではない |
| 全フレーム/音声/時計/境界 | PASS（合成入力限定） | 5/15/Reference/30秒とshifted境界は完全一致、時計templates9/9 |
| 停止・復旧 | PARTIAL | 7点の実SIGKILL後単体再生成、DB/Worker/FakeStorage upload再試行。全公開境界統合は未完了 |
| 本番image/Blitz/連続実Worker | HOLD/未検証 | 未デプロイ、実資源/無料適格性/0.05CPU持続保証なし |

診断はhost cache温冷を制御せず、runtimeバイナリ等のfile pageが親/共有側に課金され得る。1GB移行時にも本番image・fresh/cold/warm条件・実プラットフォームの課金scopeを照合し、この診断cgroup値を予約枠やアカウント全体memoryへ読み替えない。
