# ネットワークを使わない合成media fixture

現在の契約試験はプログラム生成したmetadataのみを使う。外部素材・URL・クラウド・認証不要。codec接続時は次の独立fixture生成器を追加する（V0でffmpeg依存は追加しない）。

1. ローカルffmpegのlavfi `testsrc2=size=64x64:rate=60:duration=2` と `sine=frequency=440:sample_rate=48000:duration=2` から固定パラメータのWebM/PCM WAVを作る。別途無音・音声のみ・縦長・端数durationも生成する。入力にURLを許可せず、ネットワークを無効にした環境で生成する。
2. 実行バージョン、引数、seed、寸法、sample rate、frame数、durationUs、実ファイルSHA-256をmanifestに固定する。異なるcodecビルド間でbytes一致を仮定せず、基準ビルドを固定する。
3. 長時間は巨大mediaを作らずsafe-integer境界のmetadataで試験。連結丸めは20ms clipを100連結し120frameを期待する。境界の直前/直後、0frame、重複marker、重なる範囲、数不一致、危険filenameを別fixtureにする。
4. bytes fixtureは小容量とし、decode検証ではsignature/MIME/duration/dimensions/hashを照合する。切断・hash違い・未知versionも生成する。期待値はdecoder出力をそのままコピーせず、既知のsample/frame数から算出する。
5. 生成物はwork/へ置く。試験が外部downloadにfallbackしないことを確認する。既存画像fixtureとバックアップfixtureは変更しない。
