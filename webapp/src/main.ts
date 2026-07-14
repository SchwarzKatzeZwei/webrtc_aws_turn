import "./style.css";
import { appConfig, readMode, validateAppConfig, type NatMode } from "./config";
import type { KvsDestinations } from "./kvs";
import { ReceiverSession } from "./receiver";
import { SenderSession, type SessionCallbacks } from "./sender";
import { emptySignalingActivity, type SignalingActivity } from "./signaling-activity";
import {
  emptyWebRtcStats,
  StatsMonitor,
  type CandidateEndpoint,
  type CandidatePath,
  type WebRtcStats,
} from "./stats";

const mode = readMode();
const isSender = mode === "sender";
const NO_MICROPHONE_VALUE = "__none__";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app が見つかりません。");

app.innerHTML = `
  <div class="shell">
    <a class="skip-link" href="#main-content">メインコンテンツへ移動</a>
    <header class="topbar">
      <a class="brand" href="?mode=${mode}" aria-label="KVS Link Atlas">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span><strong>KVS Link Atlas</strong><small>Realtime WebRTC route monitor</small></span>
      </a>
      <nav class="mode-switch" aria-label="動作モード">
        <a class="${isSender ? "active" : ""}" href="?mode=sender">Sender</a>
        <a class="${!isSender ? "active" : ""}" href="?mode=receiver">Receiver</a>
      </nav>
      <div class="topbar-status">
        <span id="session-indicator" class="session-indicator" aria-live="polite" aria-atomic="true"><i aria-hidden="true"></i><b id="session-status">OFFLINE</b></span>
        <span class="topbar-clock"><b>SESSION</b><code id="elapsed-time">00:00</code></span>
      </div>
    </header>

    <main id="main-content">
      <section class="cockpit-grid">
        <article class="topology-card panel">
          <div class="panel-head topology-head">
            <div>
              <span class="eyebrow">LIVE DESTINATIONS</span>
              <h1>送信先マップ</h1>
              <p>シグナリングとメディアが、今どこを通っているか。</p>
            </div>
            <span id="route-badge" class="route-badge unknown" aria-live="polite" aria-atomic="true"><i aria-hidden="true"></i>WAITING</span>
          </div>

          <div id="topology-stage" class="topology-stage" data-path="unknown" data-phase="idle" role="img" aria-label="未接続。接続するとWebRTCの送信先と経路が表示されます。">
            <svg class="topology-canvas" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <radialGradient id="atlasGlow"><stop offset="0" stop-color="#2be99a" stop-opacity=".16"/><stop offset="1" stop-color="#2be99a" stop-opacity="0"/></radialGradient>
              </defs>
              <ellipse class="atlas-glow" cx="540" cy="280" rx="430" ry="280" fill="url(#atlasGlow)"/>
              <g class="atlas-grid">
                <ellipse cx="520" cy="275" rx="365" ry="205"/>
                <ellipse cx="520" cy="275" rx="260" ry="205"/>
                <ellipse cx="520" cy="275" rx="135" ry="205"/>
                <path d="M155 275h730M182 190h676M182 360h676"/>
                <path d="M520 70v410"/>
              </g>
              <g class="world-mass">
                <path d="M262 177l42-34 55 7 30 27 44 9 18 24-24 25-55 5-18 42-38-1-17-35-46-12-24-29z"/>
                <path d="M414 293l35 20 17 49-8 54-32 48-29-38 2-64-20-38z"/>
                <path d="M569 168l52-22 45 20 72 5 49 30-12 27-66 10-26 36-54-10-19-35-56-19z"/>
                <path d="M675 310l38 8 31 30-15 28-42 8-24-29z"/>
              </g>
              <path class="route-line signaling-line" d="M150 322 C 270 154, 392 120, 520 120"/>
              <path class="route-line direct-line" d="M150 322 C 348 448, 662 448, 860 322"/>
              <path class="route-line relay-line" d="M150 322 C 278 322, 400 322, 520 322 C 650 322, 744 322, 860 322"/>
              <path class="route-trace signaling-trace" d="M150 322 C 270 154, 392 120, 520 120"/>
              <path class="route-trace direct-trace" d="M150 322 C 348 448, 662 448, 860 322"/>
              <path class="route-trace relay-trace" d="M150 322 C 278 322, 400 322, 520 322 C 650 322, 744 322, 860 322"/>
            </svg>

            <div id="local-node" class="map-node local-node active">
              <span class="node-orbit"><i class="node-core device-core">⌁</i></span>
              <div class="node-label"><small>${isSender ? "THIS SENDER" : "THIS RECEIVER"}</small><strong>この端末</strong><span id="local-node-detail">Browser · candidate待ち</span></div>
            </div>
            <div id="signaling-node" class="map-node signaling-node">
              <span class="node-orbit"><i class="node-core aws-core">A</i></span>
              <div class="node-label">
                <small>AWS SIGNALING</small>
                <strong id="signaling-node-title">未検出</strong>
                <span id="signaling-node-detail">${escapeHtml(appConfig.region || "region未設定")}</span>
                <div id="signaling-activity" class="signaling-activity" title="SDP・ICE・Statusの概算アプリペイロード">
                  <span id="signaling-activity-summary">↑0 ↓0 · ~0 B</span>
                  <small id="signaling-activity-last">NO MESSAGES</small>
                </div>
              </div>
            </div>
            <div id="relay-node" class="map-node relay-node">
              <span class="node-orbit"><i class="node-core relay-core">R</i></span>
              <div class="node-label"><small>TURN RELAY</small><strong id="relay-node-title">Standby</strong><span id="relay-node-detail">接続時に取得</span></div>
            </div>
            <div id="peer-node" class="map-node peer-node">
              <span class="node-orbit"><i class="node-core peer-core">↗</i></span>
              <div class="node-label align-right"><small>${isSender ? "REMOTE VIEWER" : "REMOTE MASTER"}</small><strong id="peer-node-title">接続待ち</strong><span id="peer-node-detail">remote candidate</span></div>
            </div>

            <div id="traffic-chip" class="traffic-chip" aria-live="polite">
              <small>LIVE TRAFFIC</small>
              <strong id="map-throughput">計測中</strong>
              <span id="map-traffic-total">${isSender ? "送信" : "受信"} · 0 B total</span>
            </div>

            <div id="topology-idle" class="topology-idle">
              <i aria-hidden="true"></i><span>接続を開始すると、実際の送信先がここに現れます</span>
            </div>
          </div>

          <div class="destination-strip">
            <div><small>SELECTED DESTINATION</small><strong id="selected-destination">未接続</strong></div>
            <div><small>MEDIA ROUTE</small><strong id="selected-route">候補待ち</strong></div>
            <p><i aria-hidden="true"></i>ノード位置は地理座標ではなく、接続関係を示す概念図です。</p>
          </div>
        </article>

        <aside class="control-card panel">
          <div class="panel-head compact">
            <div><span class="eyebrow">CONNECTION</span><h2>接続コントロール</h2></div>
            <span class="role-tag ${isSender ? "master" : "viewer"}">${isSender ? "MASTER" : "VIEWER"}</span>
          </div>

          <div class="channel-block">
            <span><small>REGION</small><code>${escapeHtml(appConfig.region || "未設定")}</code></span>
            <span><small>CHANNEL</small><code>${escapeHtml(appConfig.channelName || "未設定")}</code></span>
          </div>

          <div class="control-section">
            <label class="section-label">通信経路</label>
            <div class="route-switch" role="radiogroup" aria-label="通信経路">
              <label>
                <input type="radio" name="nat-mode" value="p2p" checked>
                <span><b>P2P優先</b><small>直接接続 → TURN fallback</small></span>
              </label>
              <label>
                <input type="radio" name="nat-mode" value="turn">
                <span><b>TURN強制</b><small>AWS relayのみ</small></span>
              </label>
            </div>
          </div>

          ${isSender ? `
          <div class="control-section devices">
            <label class="field-label" for="camera-select"><span>カメラ</span><select id="camera-select" name="camera"><option value="">Default camera</option></select></label>
            <label class="field-label" for="microphone-select"><span>マイク</span><select id="microphone-select" name="microphone"><option value="">Default microphone</option><option value="${NO_MICROPHONE_VALUE}">なし（映像のみ）</option></select></label>
            <button id="preview-button" class="text-button" type="button">デバイスを再取得</button>
          </div>` : `
          <div class="receiver-note">
            <span class="receiver-icon" aria-hidden="true">↙</span>
            <p><b>受信専用</b><small>カメラ・マイクは送信せず、MASTERのメディアだけを受信します。</small></p>
          </div>`}

          <div class="connection-summary">
            <span><small>Signaling</small><b id="signaling-state">未接続</b></span>
            <span><small>${isSender ? "Viewers" : "Peer"}</small><b id="peer-summary">${isSender ? "0" : "—"}</b></span>
          </div>

          <div class="action-row">
            <button id="connect-button" class="primary-button" type="button"><span class="button-icon" aria-hidden="true">↗</span>${isSender ? "送信を開始" : "接続する"}</button>
            <button id="disconnect-button" class="secondary-button" type="button" disabled>切断</button>
          </div>
          <p class="security-note"><span>!</span> AWS Access Keyはローカル実験のブラウザ内だけで使用します。画面やログには表示しません。</p>
        </aside>
      </section>

      <section class="metrics" aria-label="WebRTC統計">
        <article class="metric-card route-metric"><span>Selected route</span><div><strong id="metric-candidate">—</strong><em id="metric-candidate-detail">経路未選択</em></div></article>
        <article class="metric-card"><span>Round trip</span><div><strong id="metric-rtt">—</strong><em>RTT</em></div></article>
        <article class="metric-card"><span>Throughput</span><div><strong id="metric-bitrate">—</strong><em>${isSender ? "OUTBOUND" : "INBOUND"}</em></div></article>
        <article class="metric-card"><span>Packet loss</span><div><strong id="metric-loss">—</strong><em>SELECTED PAIR</em></div></article>
      </section>

      <section class="lower-grid">
        <article class="video-card panel">
          <div class="panel-head compact">
            <div><span class="eyebrow">${isSender ? "LOCAL SOURCE" : "REMOTE STREAM"}</span><h2>${isSender ? "送信プレビュー" : "受信モニター"}</h2></div>
            <span id="video-live-badge" class="live-badge"><i aria-hidden="true"></i>${isSender ? "PREVIEW" : "WAITING"}</span>
          </div>
          <div class="video-frame">
            <video id="media-view" autoplay playsinline ${isSender ? "muted" : "controls"}></video>
            <div id="video-placeholder" class="video-placeholder">
              <div class="signal-orbit" aria-hidden="true"><span></span><span></span><span></span></div>
              <strong>${isSender ? "カメラを準備しています" : "Senderからの映像を待っています"}</strong>
              <small>${isSender ? "カメラ利用を許可してください（マイクは任意）" : "接続するとリモート映像が表示されます"}</small>
            </div>
            <div class="video-caption"><span>${isSender ? "LOCAL CAPTURE" : "REMOTE MEDIA"}</span><span id="video-route-caption">NO ROUTE</span></div>
          </div>
        </article>

        <article class="destination-card panel">
          <div class="panel-head compact"><div><span class="eyebrow">ROUTE INSPECTOR</span><h2>宛先の詳細</h2></div><span id="pair-badge" class="pair-badge unknown">UNKNOWN</span></div>
          <dl class="destination-list">
            <div><dt>Signaling</dt><dd id="detail-signaling">—</dd></div>
            <div><dt>TURN servers</dt><dd id="detail-turn">—</dd></div>
            <div><dt>Local candidate</dt><dd id="detail-local">—</dd></div>
            <div class="destination-emphasis"><dt>Remote destination</dt><dd id="detail-remote">—</dd></div>
            <div><dt>Transport</dt><dd id="detail-transport">—</dd></div>
            <div><dt>ICE state</dt><dd><span id="ice-state">new</span><i id="state-dot" class="state-dot" aria-hidden="true"></i></dd></div>
          </dl>
        </article>

        <article class="log-panel panel">
          <div class="panel-head compact"><div><span class="eyebrow">EVENT STREAM</span><h2>接続ログ</h2></div><button id="clear-log" class="text-button" type="button">Clear</button></div>
          <div id="event-log" class="event-log" aria-live="polite"></div>
        </article>
      </section>
    </main>
  </div>
`;

const mediaView = element<HTMLVideoElement>("media-view");
const placeholder = element<HTMLDivElement>("video-placeholder");
const connectButton = element<HTMLButtonElement>("connect-button");
const disconnectButton = element<HTMLButtonElement>("disconnect-button");
const signalingState = element<HTMLElement>("signaling-state");
const peerSummary = element<HTMLElement>("peer-summary");
const iceState = element<HTMLElement>("ice-state");
const stateDot = element<HTMLElement>("state-dot");
const elapsedTime = element<HTMLElement>("elapsed-time");
const eventLog = element<HTMLElement>("event-log");
const videoBadge = element<HTMLElement>("video-live-badge");
const topologyStage = element<HTMLElement>("topology-stage");
const sessionIndicator = element<HTMLElement>("session-indicator");
const sessionStatus = element<HTMLElement>("session-status");
const senderSession = isSender ? new SenderSession() : null;
const receiverSession = !isSender ? new ReceiverSession() : null;
const statsMonitor = new StatsMonitor();

let localStream: MediaStream | null = null;
let isConnected = false;
let connectedAt = 0;
let elapsedTimer: number | null = null;
let destinations: KvsDestinations | null = null;
let currentStats = emptyWebRtcStats();
let currentSignalingActivity = emptySignalingActivity();

const log = (message: string, level: "info" | "success" | "warn" | "error" = "info"): void => {
  const item = document.createElement("div");
  item.className = `log-line ${level}`;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  eventLog.prepend(item);
  while (eventLog.children.length > 50) eventLog.lastElementChild?.remove();
};

const callbacks: SessionCallbacks = {
  onLog: log,
  onSignalingState: (state) => {
    signalingState.textContent = state;
    sessionStatus.textContent = state;
  },
  onPeerState: (state, currentIceState) => {
    peerSummary.textContent = isSender ? peerSummary.textContent : labelPeerState(state);
    iceState.textContent = currentIceState;
    stateDot.className = `state-dot ${state === "connected" ? "connected" : state === "failed" ? "failed" : ""}`;
    topologyStage.dataset.peerState = state;
    sessionIndicator.className = `session-indicator ${state === "connected" ? "online" : state === "failed" ? "failed" : "working"}`;
    if (state === "connected") sessionStatus.textContent = "LIVE";
  },
  onPeerConnection: (peer) => {
    statsMonitor.stop();
    if (peer) statsMonitor.start(peer, isSender ? "outbound" : "inbound", renderStats);
  },
  onPeerDisconnected: (_clientId, remainingViewerCount) => {
    if (remainingViewerCount > 0) return;
    renderStats(emptyWebRtcStats());
    iceState.textContent = "closed";
    stateDot.className = "state-dot";
    topologyStage.dataset.peerState = "closed";
    sessionIndicator.className = "session-indicator working";
    sessionStatus.textContent = "WAITING";
  },
  onDestinations: (nextDestinations) => {
    destinations = nextDestinations;
    renderDestinations(nextDestinations);
  },
  onSignalingActivity: (activity) => {
    currentSignalingActivity = activity;
    renderSignalingActivity(activity);
  },
  onRemoteStream: (stream) => {
    mediaView.srcObject = stream;
    placeholder.hidden = true;
    videoBadge.innerHTML = '<i aria-hidden="true"></i>LIVE';
    void mediaView.play().catch(() => log("自動再生がブロックされました。映像をクリックして再生してください", "warn"));
  },
  onViewerCount: (count) => { peerSummary.textContent = String(count); },
};

connectButton.addEventListener("click", async () => {
  if (isConnected) return;
  try {
    validateAppConfig();
    setBusy(true);
    setConnectionPhase("resolving");
    const natMode = document.querySelector<HTMLInputElement>('input[name="nat-mode"]:checked')?.value as NatMode ?? "p2p";
    log(`${natMode === "turn" ? "TURN強制" : "P2P優先"}モードで接続を開始します`);
    if (isSender) {
      if (!localStream) await startPreview();
      if (!localStream) throw new Error("送信するカメラ映像を取得できませんでした。");
      await senderSession?.start(localStream, natMode, callbacks);
    } else {
      await receiverSession?.start(natMode, callbacks);
    }
    isConnected = true;
    connectedAt = Date.now();
    startElapsedTimer();
    setConnectedUi(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message, "error");
    signalingState.textContent = "開始失敗";
    sessionIndicator.className = "session-indicator failed";
    sessionStatus.textContent = "ERROR";
    senderSession?.stop();
    void receiverSession?.stop();
    destinations = null;
    currentSignalingActivity = emptySignalingActivity();
    renderDestinations(null);
    renderStats(emptyWebRtcStats());
    renderSignalingActivity(currentSignalingActivity);
    setConnectionPhase("idle");
    const selectedMode = document.querySelector<HTMLInputElement>('input[name="nat-mode"]:checked')?.value as NatMode ?? "p2p";
    renderRoutePreference(selectedMode);
  } finally {
    setBusy(false);
  }
});

disconnectButton.addEventListener("click", () => disconnect());
element<HTMLButtonElement>("clear-log").addEventListener("click", () => { eventLog.replaceChildren(); });

const cameraSelect = document.querySelector<HTMLSelectElement>("#camera-select");
const microphoneSelect = document.querySelector<HTMLSelectElement>("#microphone-select");
document.querySelector<HTMLButtonElement>("#preview-button")?.addEventListener("click", () => void startPreview());
cameraSelect?.addEventListener("change", () => void startPreview());
microphoneSelect?.addEventListener("change", () => void startPreview());
document.querySelectorAll<HTMLInputElement>('input[name="nat-mode"]').forEach((input) => {
  input.addEventListener("change", () => renderRoutePreference(input.value as NatMode));
});

async function startPreview(): Promise<void> {
  if (!isSender) return;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  placeholder.hidden = false;
  try {
    const videoDevice = cameraSelect?.value;
    const audioDevice = microphoneSelect?.value;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: videoDevice ? { exact: videoDevice } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: audioDevice === NO_MICROPHONE_VALUE
        ? false
        : audioDevice
          ? { deviceId: { exact: audioDevice } }
          : true,
    });
    localStream.getVideoTracks().forEach((track) => { track.contentHint = "motion"; });
    mediaView.srcObject = localStream;
    placeholder.hidden = true;
    await populateDevices();
    log(localStream.getAudioTracks().length > 0
      ? "カメラとマイクのプレビューを準備しました"
      : "カメラのみのプレビューを準備しました（マイクなし）", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`メディアを取得できませんでした: ${message}`, "warn");
  }
}

async function populateDevices(): Promise<void> {
  if (!cameraSelect || !microphoneSelect) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  replaceDeviceOptions(cameraSelect, devices.filter((device) => device.kind === "videoinput"), "Camera");
  replaceDeviceOptions(microphoneSelect, devices.filter((device) => device.kind === "audioinput"), "Microphone", true);
}

function replaceDeviceOptions(select: HTMLSelectElement, devices: MediaDeviceInfo[], fallback: string, includeNoMicrophone = false): void {
  const current = select.value;
  const options = devices.map((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${fallback} ${index + 1}`;
    return option;
  });
  if (includeNoMicrophone) {
    const noMicrophone = document.createElement("option");
    noMicrophone.value = NO_MICROPHONE_VALUE;
    noMicrophone.textContent = "なし（映像のみ）";
    options.push(noMicrophone);
  }
  select.replaceChildren(...options);
  if (current === NO_MICROPHONE_VALUE || devices.some((device) => device.deviceId === current)) {
    select.value = current;
  }
}

function disconnect(): void {
  senderSession?.stop();
  void receiverSession?.stop(true);
  statsMonitor.stop();
  isConnected = false;
  destinations = null;
  currentSignalingActivity = emptySignalingActivity();
  signalingState.textContent = "切断済み";
  peerSummary.textContent = isSender ? "0" : "—";
  iceState.textContent = "closed";
  stateDot.className = "state-dot";
  sessionIndicator.className = "session-indicator";
  sessionStatus.textContent = "OFFLINE";
  setConnectedUi(false);
  stopElapsedTimer();
  renderDestinations(null);
  renderStats(emptyWebRtcStats());
  renderSignalingActivity(currentSignalingActivity);
  setConnectionPhase("idle");
  if (!isSender) {
    mediaView.srcObject = null;
    placeholder.hidden = false;
    videoBadge.innerHTML = '<i aria-hidden="true"></i>WAITING';
  }
  log("接続を切断しました", "warn");
}

function renderDestinations(nextDestinations: KvsDestinations | null): void {
  const signalingHost = nextDestinations?.signalingHost ?? "";
  const turnHosts = nextDestinations?.turnHosts ?? [];
  setText("signaling-node-title", signalingHost ? compactHost(signalingHost) : "未検出");
  setText("signaling-node-detail", nextDestinations?.region || appConfig.region || "region未設定");
  setText("relay-node-title", turnHosts.length > 0 ? compactHost(turnHosts[0] ?? "") : "Standby");
  setText("relay-node-detail", turnHosts.length > 1 ? `ほか ${turnHosts.length - 1} endpoint` : turnHosts.length === 1 ? "AWS managed relay" : "接続時に取得");
  setText("detail-signaling", signalingHost || "—");
  setText("detail-turn", turnHosts.length > 0 ? `${turnHosts[0]}${turnHosts.length > 1 ? ` +${turnHosts.length - 1}` : ""}` : "—");
  element("signaling-node").classList.toggle("active", Boolean(signalingHost));
  element("relay-node").classList.toggle("available", turnHosts.length > 0);
  if (nextDestinations) {
    setConnectionPhase("signaling");
    if (currentStats.path === "unknown") {
      setText("selected-route", "Peer candidate待ち");
      setText("route-badge", "SIGNALING");
    }
  }
}

function renderStats(stats: WebRtcStats): void {
  currentStats = stats;
  const localAddress = endpointLabel(stats.local);
  const remoteAddress = endpointLabel(stats.remote);
  const routeName = pathLabel(stats.path);
  const destination = stats.remote.address ? remoteAddress : "接続先を検出中";

  topologyStage.dataset.path = stats.path;
  topologyStage.dataset.traffic = stats.path === "unknown" ? "idle" : stats.bitrateKbps === null ? "measuring" : "live";
  topologyStage.dataset.phase = stats.path === "unknown" ? destinations ? "signaling" : "idle" : "media";
  const throughput = stats.bitrateKbps === null ? "計測中" : formatBitrate(stats.bitrateKbps);
  const direction = isSender ? "送信" : "受信";
  const flowSpeed = stats.bitrateKbps === null ? 1.8 : Math.max(.55, Math.min(1.8, 1700 / (stats.bitrateKbps + 500)));
  topologyStage.style.setProperty("--flow-speed", `${flowSpeed.toFixed(2)}s`);
  topologyStage.setAttribute("aria-label", stats.path === "unknown"
    ? "接続先を検出中です。"
    : `${routeName}で${destination}へ接続しています。現在の${direction}量は${throughput}です。`);

  setText("metric-candidate", stats.path === "unknown" ? "—" : stats.path.toUpperCase());
  setText("metric-candidate-detail", stats.path === "unknown" ? "経路未選択" : `${stats.local.type} → ${stats.remote.type}`);
  setText("metric-rtt", stats.rttMs === null ? "—" : `${stats.rttMs.toFixed(0)} ms`);
  setText("metric-bitrate", stats.bitrateKbps === null ? "—" : formatBitrate(stats.bitrateKbps));
  setText("metric-loss", stats.packetLossPercent === null ? "—" : `${stats.packetLossPercent.toFixed(2)}%`);
  setText("local-node-detail", stats.local.type === "unknown" ? "Browser · candidate待ち" : `${stats.local.type} · ${localAddress}`);
  setText("peer-node-title", stats.remote.address ? compactHost(stats.remote.address) : stats.remote.type === "unknown" ? "接続待ち" : stats.remote.type.toUpperCase());
  setText("peer-node-detail", stats.remote.type === "unknown" ? "remote candidate" : `${stats.remote.type} · ${transportLabel(stats)}`);
  setText("selected-destination", stats.remote.address ? remoteAddress : "未接続");
  setText("selected-route", routeName);
  setText("detail-local", stats.local.type === "unknown" ? "—" : `${localAddress} · ${stats.local.type}`);
  setText("detail-remote", stats.remote.type === "unknown" ? "—" : `${remoteAddress} · ${stats.remote.type}`);
  setText("detail-transport", stats.path === "unknown" ? "—" : transportLabel(stats));
  setText("video-route-caption", stats.path === "unknown" ? "NO ROUTE" : routeName.toUpperCase());
  setText("map-throughput", throughput);
  setText("map-traffic-total", `${direction} · ${formatBytes(stats.bytesTransferred)} total`);
  setText("pair-badge", stats.path.toUpperCase());
  setText("route-badge", stats.path === "unknown" ? destinations ? "SIGNALING" : "WAITING" : stats.path === "relay" ? "VIA TURN" : "DIRECT PATH");
  element("pair-badge").className = `pair-badge ${stats.path}`;
  element("route-badge").className = `route-badge ${stats.path}`;
  element("peer-node").classList.toggle("active", stats.remote.type !== "unknown");
  element("relay-node").classList.toggle("active", stats.path === "relay");
}

function renderSignalingActivity(activity: SignalingActivity): void {
  const totalMessages = activity.sentMessages + activity.receivedMessages;
  const totalBytes = activity.sentBytes + activity.receivedBytes;
  setText("signaling-activity-summary", `↑${activity.sentMessages} ↓${activity.receivedMessages} · ~${formatBytes(totalBytes)}`);
  setText("signaling-activity-last", activity.lastActivityAt === 0 ? "NO MESSAGES" : relativeActivityTime(activity.lastActivityAt));
  const activityElement = element("signaling-activity");
  activityElement.dataset.active = String(totalMessages > 0);
  activityElement.setAttribute(
    "aria-label",
    `AWS Signalingは送信${activity.sentMessages}件、受信${activity.receivedMessages}件、概算ペイロード${formatBytes(totalBytes)}です。`,
  );
}

function setConnectionPhase(phase: "idle" | "resolving" | "signaling"): void {
  if (currentStats.path !== "unknown" && phase !== "idle") return;
  topologyStage.dataset.phase = phase;
  if (phase === "resolving") {
    sessionIndicator.className = "session-indicator working";
    sessionStatus.textContent = "RESOLVING";
    setText("selected-route", "AWS endpointを取得中");
  }
}

function renderRoutePreference(natMode: NatMode): void {
  if (isConnected) return;
  setText("selected-route", natMode === "turn" ? "TURN relayを強制" : "P2Pを優先");
  setText("route-badge", natMode === "turn" ? "TURN READY" : "P2P READY");
}

function setBusy(busy: boolean): void {
  connectButton.disabled = busy || isConnected;
  connectButton.classList.toggle("loading", busy);
  if (busy) connectButton.textContent = "接続準備中…";
  else connectButton.innerHTML = `<span class="button-icon" aria-hidden="true">↗</span>${isSender ? "送信を開始" : "接続する"}`;
}

function setConnectedUi(connected: boolean): void {
  connectButton.disabled = connected;
  disconnectButton.disabled = !connected;
  document.querySelectorAll<HTMLInputElement>('input[name="nat-mode"]').forEach((input) => { input.disabled = connected; });
  if (cameraSelect) cameraSelect.disabled = connected;
  if (microphoneSelect) microphoneSelect.disabled = connected;
}

function startElapsedTimer(): void {
  stopElapsedTimer();
  const update = (): void => {
    const seconds = Math.floor((Date.now() - connectedAt) / 1000);
    elapsedTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    renderSignalingActivity(currentSignalingActivity);
  };
  update();
  elapsedTimer = window.setInterval(update, 1000);
}

function stopElapsedTimer(): void {
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  elapsedTime.textContent = "00:00";
}

function endpointLabel(endpoint: CandidateEndpoint): string {
  if (!endpoint.address) return "ブラウザ非公開";
  const address = endpoint.address.includes(":") && !endpoint.address.startsWith("[") ? `[${endpoint.address}]` : endpoint.address;
  return endpoint.port === null ? address : `${address}:${endpoint.port}`;
}

function transportLabel(stats: WebRtcStats): string {
  const protocol = stats.local.protocol || stats.remote.protocol || "unknown";
  const relayProtocol = stats.local.relayProtocol || stats.remote.relayProtocol;
  return relayProtocol ? `${protocol.toUpperCase()} / ${relayProtocol.toUpperCase()}` : protocol.toUpperCase();
}

function pathLabel(path: CandidatePath): string {
  const labels: Record<CandidatePath, string> = {
    host: "LAN / host candidate",
    srflx: "P2P / STUN public address",
    relay: "AWS TURN relay",
    prflx: "P2P / peer reflexive",
    unknown: "候補待ち",
  };
  return labels[path];
}

function compactHost(value: string): string {
  if (value.length <= 28) return value;
  const parts = value.split(".");
  if (parts.length > 2) return `${parts[0]}.${parts[1]}…`;
  return `${value.slice(0, 25)}…`;
}

function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps.toFixed(0)} kbps`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function relativeActivityTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 2) return "NOW";
  if (seconds < 60) return `${seconds}s AGO`;
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m AGO`;
  return `${Math.floor(seconds / (60 * 60))}h AGO`;
}

function labelPeerState(state: RTCPeerConnectionState): string {
  const labels: Record<RTCPeerConnectionState, string> = {
    new: "準備中", connecting: "接続中", connected: "接続済み", disconnected: "中断", failed: "失敗", closed: "切断済み",
  };
  return labels[state];
}

function setText(id: string, value: string): void {
  element(id).textContent = value;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} が見つかりません。`);
  return found as T;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

window.addEventListener("beforeunload", () => {
  senderSession?.stop();
  void receiverSession?.stop(true);
  localStream?.getTracks().forEach((track) => track.stop());
});

renderStats(currentStats);
renderSignalingActivity(currentSignalingActivity);
renderRoutePreference("p2p");
log(`${isSender ? "Sender / MASTER" : "Receiver / VIEWER"} モードを読み込みました`);
if (isSender) void startPreview();
