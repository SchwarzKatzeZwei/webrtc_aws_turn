# WebRTC AWS TURN

2台のノートPC間で、Amazon Kinesis Video Streams WebRTCのP2P接続とTURN Relay接続を比較し、実際の送信先と選択経路をライブマップで確認できるローカル実験環境です。

送信側はMASTER、受信側はVIEWERとして同じSignaling Channelへ接続します。録画・配信サーバー・Cognitoは使用しません。

## 構成

```text
terraform/  Signaling Channel、IAM User、IAM Policy、Access Key
webapp/     Vite + TypeScriptのSender／Receiver共通アプリ
```

Terraformでは、Signaling ChannelだけAWS Cloud Control Provider（`awscc`）、IAMは通常のAWS Provider（`aws`）で管理します。AWS側に作成される実体は次の4つだけです。

- Kinesis Video Streams Signaling Channel × 1
- IAM User × 1（コンソールログインなし）
- IAM Policy × 1
- Access Key × 1

## 前提

- Terraform 1.6以上
- Node.js 22.12以上
- Chrome、Edge、またはChromium
- Terraform実行用のAWS認証情報

## 1. AWSリソースを作成する

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

作成後、Webアプリ用の値を確認します。

```bash
terraform output -raw aws_region
terraform output -raw signaling_channel_name
terraform output -raw signaling_channel_arn
terraform output -raw aws_access_key_id
terraform output -raw aws_secret_access_key
```

Secret Access KeyはTerraform Stateに平文相当で保存されます。Stateを共有ストレージやGitへ置かないでください。

## 2. 各PCのWebアプリを設定する

送信PCと受信PCの両方で、`webapp/.env.local`を作成します。

```bash
cd webapp
cp .env.example .env.local
```

Terraformの出力値を設定します。

```dotenv
VITE_AWS_REGION=ap-northeast-1
VITE_KVS_CHANNEL_NAME=laptop-webrtc-sample
VITE_AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxx
VITE_AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`VITE_`変数はブラウザ向けJavaScriptへ組み込まれます。このアプリをインターネットへ公開しないでください。

## 3. 起動する

両方のPCで実行します。

```bash
npm install
npm run dev
```

最初に送信PCで次を開き、カメラと必要に応じてマイクを許可して「送信を開始」を押します。

```text
http://localhost:5173/?mode=sender
```

音声を送信しない場合は、接続前にマイクから「なし（映像のみ）」を選択してください。選択後は音声を含めず、カメラ映像だけを送信します。

次に受信PCで次を開き、「接続する」を押します。

```text
http://localhost:5173/?mode=receiver
```

別PCの開発サーバーへアクセスする必要はありません。それぞれのPCで`localhost`として起動します。

### 1台で起動して、別PCからHTTPSで開く

送信PCと受信PCを同じTailscaleネットワークへ参加させると、証明書を手動設定せずにプライベートなHTTPS URLを利用できます。

Webアプリを起動したまま、別のターミナルで共有を開始します。

```bash
cd webapp
npm run share
```

表示された`https://<端末名>.<tailnet名>.ts.net`を別PCで開きます。

```text
https://<端末名>.<tailnet名>.ts.net/?mode=sender
https://<端末名>.<tailnet名>.ts.net/?mode=receiver
```

共有状態の確認と停止は次のコマンドです。

```bash
npm run share:status
npm run share:stop
```

初回はTailscaleからHTTPS機能を有効化するための案内が表示される場合があります。AWS Access Keyをブラウザへ埋め込むローカル実験用構成のため、公開URLになるTailscale Funnelやパブリックトンネルは使用しないでください。

## 接続モード

- `P2P優先`: STUNとTURNをICE Serverへ渡し、ブラウザが直接経路を優先します。直接接続できない場合はTURNへフォールバックします。
- `TURN強制`: TURN Serverだけを使用し、`iceTransportPolicy: "relay"`で接続します。

選択されたCandidate Pairは画面下部に表示されます。

接続後は送信先マップに次の実データが表示されます。

- AWS Kinesis Video StreamsのSignaling endpoint
- AWSから取得したTURN server endpoint
- ブラウザが選択したLocal／Remote ICE Candidateのアドレスとポート
- P2Pの直接経路またはTURN Relay経路

ノード位置は地理情報ではなく接続関係を表す概念図です。アドレスはブラウザのプライバシー保護によって非公開になる場合があります。

- `host`: ローカルCandidate
- `srflx`: STUNで得た外部Candidate
- `relay`: AWS TURN Relay
- `prflx`: Peer Reflexive Candidate

RTT、送受信ビットレート、パケットロス、ICE Stateも1秒ごとに更新されます。

## IAM最小権限

ポリシーは作成したSignaling Channel ARNだけを対象に、次の操作のみ許可します。

```text
kinesisvideo:DescribeSignalingChannel
kinesisvideo:GetSignalingChannelEndpoint
kinesisvideo:GetIceServerConfig
kinesisvideo:ConnectAsMaster
kinesisvideo:ConnectAsViewer
```

## 終了と削除

実験後はAWSリソースを削除します。

```bash
cd terraform
terraform destroy
```

`terraform destroy`完了後、不要になった`terraform.tfstate*`と各PCの`webapp/.env.local`を安全に削除してください。Access Keyが残っていないことはIAMコンソールまたはAWS CLIでも確認してください。

## 注意事項

- 1つのSignaling Channelに接続できるMASTERは1つです。
- ブラウザの自動再生ポリシーにより受信音声が始まらない場合は、受信映像の再生ボタンを押してください。
- TURNの認証情報には短い有効期限があります。長時間接続し直す場合は、いったん切断して再接続してください。
- この構成はローカル実験専用です。公開環境ではCognito、バックエンド署名、短期認証情報などへ置き換えてください。
