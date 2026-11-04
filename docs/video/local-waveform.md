# 端末内音声波形の自動解析

## 原因と変更範囲

旧LocalTimelineは「波形を生成」の明示クリック後に、ファイル全体をArrayBufferにし、AudioContext.decodeAudioDataで音声全体をデコードしていた。32MiBまたは600秒を超えると解析せず終了したため、363秒のMOVも映像のファイルサイズだけで対象外になった。両ツール共通のローカル解析サービスとReact hookへ置き換えた。AGENTS.mdはリポジトリ・親ディレクトリの検索で見つからなかった。既存Studio/Workflow、パスコード、クラウドAPI、出力エンコーダーは変更しない。

## 方式とSafariの制約

Mediabunny 1.65.1（MPL-2.0、無改変・バージョン固定）でBlobの必要範囲だけを読み、音声トラックを取り出す。MOV/MP4の**映像はデコードしない**。

- AAC: 約4秒ずつ、音声だけのMP4にリマックスし、その小ファイルをWeb Audioでデコードする。MP3も音声パケットから小さなMP3を生成する。これは圧縮ファイルを任意のバイト境界で切ってdecodeAudioDataへ渡す方式ではない。コンテナを解析し、デコーダー設定・パケット境界を保持して再構築する。
- 前の約0.2秒をプリロールし、境界部分のデコーダー立ち上がりを吸収する。元パケットのタイムスタンプへ戻して、今回の区間だけを集計する。異常な時間ギャップ、4.5秒超のチャンク、デコード時間長とパケット時間長の差が60ms超の場合は停止する。音声のコーデック・OS実装による数十ms程度の境界誤差はあり得る。サンプル精度の編集基準ではなく、音の位置を見つける補助表示。
- WAV/PCMはライブラリの小さなPCMサンプルを順次集計する（AudioDecoder不要）。その他の音声は、ブラウザがAudioSampleSinkでデコードできる場合のみ対応する。未対応を無音として扱わない。
- AAC/MP3/PCMの経路はWebCodecs AudioDecoder、AudioEncoder、Web Worker、AudioWorklet、MediaElementの自動再生に依存しない。AudioContextはdecode用途のみで再生・resumeしない。Safariのタップによる再生許可はプレビュー・既存書き出しの処理を維持する。
- decodeAudioDataは入力バッファ全体を展開し、ストリーミングAPIでもAbortSignal対応でもない。そのため必ず小さな音声専用チャンクに限定する。Workerへ移すだけではこの問題は解決しない。

参考: [MDN decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)、[Web Audio仕様](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata)、[WebCodecs仕様](https://www.w3.org/TR/webcodecs/)、[Mediabunnyソース](https://github.com/Vanilagy/mediabunny/tree/v1.65.1)。ライブラリのPCM decoder、BlobSource、AudioBufferSink、EncodedPacketSinkの実装も確認した。

## 上限とメモリ

32MiB・10分という**素材全体の制限は廃止**し、処理単位を制限する。音声が対応形式なら363秒・32MiB超MOVや603秒音声も解析できる。無制限の一括デコードには置き換えていない。

- Blob読み取りキャッシュ2MiB。BlobSourceはslice読み取りを使用（stream readerを無効化して解放とSafariのreader問題を避ける）。圧縮音声チャンク4MiB以下、時間4.5秒以下。8ch/96kHz以下。音声データの異常な大きさや対応外の設定は安全に失敗する。
- AAC/MP3のAudioContextは8kHz。ネイティブデコーダー内部では元sample rateのPCMが一時的に作られる可能性があるため、元PCM換算でもチャンク時間・ch/sample rateを制限している。ブラウザ/OSの内部確保量の上限を保証するものではない。
- 波形は20ms/binを基本に、長時間は最大20,000binへ粗くする。全chのmin/maxを集計し、逆位相を平均して消さない。値は最大約40,000個（JS number本体約320KB/素材、配列・React・キャッシュの管理領域は別）。UI更新時のコピーも同じ上限。未解析部分は波形を描かない。無音は最小バーで表現する。
- 同時デコードは両ツール・全素材を通じて1件。UIへの通知を約200ms間隔に抑え、チャンク間/PCMサンプル間にイベントループへ制御を返す。解析中も編集できる。
- 完了データのみFileをキーとするWeakMapに保持。同じFileのトリム・並べ替え・表示変更では再解析しない。ファイル内容のハッシュを計算するための全体読み込みは行わない。削除したFileを他で保持しなければGC可能。再選択で作られた別Fileは再解析する。
- ファイルのsample table等のコンテナメタデータ、ブラウザのcodec・GC・プレビュー・完成Blob、読み込み済み素材の本数に応じた総メモリは別途必要。2MiBの読み取りキャッシュはプロセス全体のメモリ上限ではない。破損/極端に巨大なコンテナの完全なメモリ保証はしない。

## ライフサイクルと表示

素材のメタデータ読込後に自動開始する。待機/解析％/完了/音声トラックなし/失敗を表示する。最初に選択した音声トラックが対象。解析失敗・キャンセルは編集や出力を無効化しない。

キャンセルと素材削除/差し替えではAbortControllerで新たな読み取り・デコード・通知を停止しInputをdisposeする。進行中のdecodeAudioData自体は止められず、終了後に結果を破棄しAudioContextをcloseする。それまでは次のデコードを開始しない。古い非同期結果はeffectのactiveフラグとFileの照合で別素材へ混入させない。

visibilitychangeでhiddenになった未完了解析は停止し、「波形を再解析」で前景に戻ってからやり直す。バックグラウンドでの継続・画面ロック越しの完了・OSに終了されたタブの復元は保証しない。中断前に完了した波形はそのタブのFileがある間保持する。再解析は先頭から行う。

ソース時刻で配置し、トリム・ズーム・スクロールに合わせて既存Timelineの可視部分だけをCanvas描画する。バー間隔は少なくとも元ピークの時間粒度とし、ズームしても同じピークを細かい波として捏造しない。All Versionsの追加選択は既存素材へ追加、FNFは単一素材の差し替えを維持する。削除・差し替えで古いsource object URLも解放する。

## 検証記録

検証結果はPRへ記載する。Chromiumで実音声（無音/有音が既知の位置にある合成音）をMP3/WAV/M4A/MP4/MOVへ変換し、AudioDecoderを意図的に無効化して解析・Canvas表示を確認する。363秒MOVに有効なfree boxを加え33MiB超にしたケース、603秒M4A、音声なしMP4も使用する。これは実ユーザーの363秒MOVそのものの再現ではない。

キャンセル、解析中のキー編集、再解析、中断、削除・再追加、複数素材、ズーム・スクロール、破損素材後の編集、強制した波形解析エラー後の実際の動画出力を検証する。ピーク集計の時間位置・逆位相・無音・長時間上限は単体テストで確認する。WebKitもCIの既存video:browserプロジェクトに含める。

ローカルではWebKitダウンロード先がネットワークポリシーにより403となった。実機iPhone Safariの低メモリ時・長時間・画面ロックからの復帰試験は未実施。Linux WebKitの成功をiPhone実機の成功とは扱わない。

### ローカル実行結果

- 型チェック・全体Lint成功。単体テスト38ファイル/319件成功。
- Next.js本番静的ビルド成功（初回のsandbox内実行はTypeScript子プロセスの出力取得で停止したため、ネットワーク許可付きの同じコマンドで再実行）。
- Chromiumの新規解析試験8件および既存preview試験5件が成功。All Versionsの全形式取込・結合書き出し試験も成功。
- 強制した波形解析失敗後のFNF書き出し試験は再実行で成功し、保存物の音声・映像トラックをffprobeで確認した。
- 既存FNFの1秒書き出し試験はローカルChromiumで映像トラックなしとなった。同一テストを変更前main（a5784ed）の独立worktreeで実行して同じ失敗を再現した。波形解析とは独立した既存のローカル環境差として記録し、テストを削除・緩和せずCIでも確認する。
