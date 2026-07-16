# Python KVS WebRTC Viewer

AWS Kinesis Video Streams WebRTCのSignaling Channelへ`VIEWER`として接続し、ブラウザ`MASTER`から次のデータを受信するデモです。

- 映像: `aiortc` / PyAVでデコードし、`numpy.ndarray`へ変換してOpenCVで表示
- 音声: PyAVで48 kHz stereo PCMへ変換し、`sounddevice`で再生

Python側は非Trickle ICEで動作します。ローカルICE候補はSDP Offerへ含め、ブラウザMASTERから届くTrickle ICE候補はKVS signaling経由で追加します。

## セットアップ

Python 3.11〜3.13を推奨します。プロジェクトルートから仮想環境を作成します。

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

macOSでは、PyAVと`opencv-python`がそれぞれ同梱するFFmpegから、AVFoundationクラスの重複警告が起動時に表示される場合があります。このデモではAVFoundationからカメラや音声を取り込まず、WebRTC受信とOpenCV表示に使います。実行中にクラッシュする環境では、どちらか一方をシステムFFmpegへリンクしてビルドし、同じFFmpegを共有させてください。

Linuxで音声を再生する場合、PortAudioが別途必要になることがあります。

```bash
sudo apt-get install libportaudio2
```

## AWS設定

既定では既存の`../webapp/.env.local`から以下を読み込みます。

```dotenv
VITE_AWS_REGION=ap-northeast-1
VITE_KVS_CHANNEL_NAME=laptop-webrtc-sample
VITE_AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxx
VITE_AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

一時認証情報を使用する場合は`VITE_AWS_SESSION_TOKEN`も設定します。`--profile`を指定した場合はAWS CLI profileを優先します。

```bash
python receiver.py --profile your-profile --region ap-northeast-1 \
  --channel-name laptop-webrtc-sample
```

IAMには少なくとも現在のWeb VIEWERと同じ次の権限が必要です。

- `kinesisvideo:DescribeSignalingChannel`
- `kinesisvideo:GetSignalingChannelEndpoint`
- `kinesisvideo:GetIceServerConfig`
- `kinesisvideo:ConnectAsViewer`

## 実行

最初にWebアプリの送信側を開始します。

```text
http://localhost:5173/?mode=sender
```

続いてPython VIEWERを起動します。

```bash
cd python
source .venv/bin/activate
python receiver.py
```

OpenCVウィンドウで`q`またはEscを押すと終了します。ログには実際に生成されたNumPy配列のshape、dtype、受信fpsが表示されます。

```text
映像 1920x1080 / 30.0 fps / numpy=(1080, 1920, 3) uint8
```

音声デバイスがない環境や、映像だけを確認したい場合は音声再生を無効化できます。音声トラック自体は受信し、遅延が蓄積しないよう破棄します。

```bash
python receiver.py --no-audio
```

詳細ログを出す場合は`--debug`を追加します。

## 音声と映像の同期について

OpenCVは音声を扱わないため、このデモでは映像をOpenCV、音声をPortAudioへ別々に出力します。音声出力は専用スレッドで行い、音声デバイスの待ち時間がWebRTCや映像表示を止めないようにしています。また、音声キューが詰まった場合は古いデータを破棄し、遅延が増え続けることを防ぎます。

これは受信確認用であり、厳密なリップシンクを保証するプレイヤーではありません。製品で正確なA/V同期が必要な場合は、RTP/RTCP由来の時刻を共通クロックへ対応付けて映像表示時刻を調整するか、クロック同期を担当できるGStreamerなどのメディアパイプラインへ音声と映像を渡します。

このデモはKVSから`GO_AWAY`または`RECONNECT_ICE_SERVER`を受け取ると安全に終了します。長時間運用では、新しいSignaling接続とTURN認証情報を取得してセッション全体を再接続する処理を追加してください。
