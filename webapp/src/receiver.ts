import type { SignalingClient } from "amazon-kinesis-video-streams-webrtc";
import { makeViewerClientId, type NatMode } from "./config";
import {
  CONTROL_CHANNEL_LABEL,
  CONTROL_DISCONNECT,
  CONTROL_DISCONNECT_ACK,
  CONTROL_DISCONNECT_TIMEOUT_MS,
} from "./control";
import { prepareKvsConnection } from "./kvs";
import { SignalingActivityTracker } from "./signaling-activity";
import type { SessionCallbacks } from "./sender";

export class ReceiverSession {
  private signalingClient: SignalingClient | null = null;
  private peer: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private resolveDisconnectAck: (() => void) | null = null;
  private stopped = false;

  async start(natMode: NatMode, callbacks: SessionCallbacks): Promise<void> {
    this.stopped = false;
    const activity = new SignalingActivityTracker(callbacks.onSignalingActivity);
    const clientId = makeViewerClientId();
    callbacks.onSignalingState("AWS設定を確認中");
    callbacks.onLog(`VIEWER ID: ${clientId}`);

    const context = await prepareKvsConnection("receiver", natMode, clientId);
    if (this.stopped) return;
    callbacks.onDestinations(context.destinations);
    this.signalingClient = context.signalingClient;
    this.peer = new RTCPeerConnection(context.peerConnectionConfig);
    callbacks.onPeerConnection(this.peer);

    this.controlChannel = this.peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
    this.controlChannel.addEventListener("message", ({ data }) => {
      if (data === CONTROL_DISCONNECT_ACK) this.resolveDisconnectAck?.();
    });
    this.peer.addTransceiver("video", { direction: "recvonly" });
    this.peer.addTransceiver("audio", { direction: "recvonly" });
    this.peer.addEventListener("icecandidate", ({ candidate }) => {
      if (!candidate || !this.signalingClient) return;
      this.signalingClient.sendIceCandidate(candidate);
      activity.record("sent", "ice-candidate", candidate);
    });
    this.peer.addEventListener("connectionstatechange", () => {
      if (!this.peer) return;
      callbacks.onPeerState(this.peer.connectionState, this.peer.iceConnectionState);
      if (this.peer.connectionState === "connected") {
        callbacks.onLog("MASTERからのメディア接続が確立しました", "success");
      }
    });
    this.peer.addEventListener("iceconnectionstatechange", () => {
      if (this.peer) callbacks.onPeerState(this.peer.connectionState, this.peer.iceConnectionState);
    });
    this.peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      callbacks.onRemoteStream?.(stream);
      callbacks.onLog(`${event.track.kind === "video" ? "映像" : "音声"}トラックを受信しました`, "success");
    });

    this.signalingClient.on("open", async () => {
      if (!this.peer) return;
      callbacks.onSignalingState("MASTER応答待ち");
      callbacks.onLog("VIEWERとして接続し、SDP Offerを送信します", "success");
      try {
        const offer = await this.peer.createOffer();
        await this.peer.setLocalDescription(offer);
        if (!this.peer.localDescription) throw new Error("SDP Offerを生成できませんでした。");
        if (!this.signalingClient) return;
        this.signalingClient.sendSdpOffer(this.peer.localDescription);
        activity.record("sent", "sdp-offer", this.peer.localDescription);
      } catch (error) {
        callbacks.onLog(`SDP Offerの送信に失敗しました: ${errorMessage(error)}`, "error");
      }
    });
    this.signalingClient.on("sdpAnswer", async (answer: RTCSessionDescription) => {
      activity.record("received", "sdp-answer", answer);
      if (!this.peer) return;
      try {
        await this.peer.setRemoteDescription(answer);
        this.signalingClient?.drainPendingIceCandidates();
        callbacks.onLog("MASTERからSDP Answerを受信しました", "success");
      } catch (error) {
        callbacks.onLog(`SDP Answerを適用できませんでした: ${errorMessage(error)}`, "error");
      }
    });
    this.signalingClient.on("iceCandidate", (candidate: RTCIceCandidate) => {
      activity.record("received", "ice-candidate", candidate);
      void this.peer?.addIceCandidate(candidate).catch((error: unknown) => {
        callbacks.onLog(`ICE candidateを追加できませんでした: ${errorMessage(error)}`, "warn");
      });
    });
    this.signalingClient.on("statusResponse", (response: { success?: boolean; description?: string }) => {
      activity.record("received", "status-response", response);
      if (response.success === false) callbacks.onLog(`KVS応答エラー: ${response.description ?? "詳細不明"}`, "error");
    });
    this.signalingClient.on("close", () => callbacks.onSignalingState("切断済み"));
    this.signalingClient.on("error", (error: Error) => {
      callbacks.onSignalingState("シグナリングエラー");
      callbacks.onLog(`シグナリングエラー: ${error.message}`, "error");
    });

    callbacks.onSignalingState("接続中");
    this.signalingClient.open();
  }

  async stop(notifyPeer = false): Promise<void> {
    this.stopped = true;
    const channel = this.controlChannel;
    if (notifyPeer && channel?.readyState === "open") {
      const acknowledged = new Promise<void>((resolve) => { this.resolveDisconnectAck = resolve; });
      try {
        channel.send(CONTROL_DISCONNECT);
        await Promise.race([acknowledged, delay(CONTROL_DISCONNECT_TIMEOUT_MS)]);
      } catch {
        // 通知に失敗しても、ローカル接続は必ず閉じます。
      }
    }
    this.resolveDisconnectAck = null;
    channel?.close();
    this.controlChannel = null;
    this.signalingClient?.close();
    this.signalingClient?.removeAllListeners();
    this.signalingClient = null;
    this.peer?.close();
    this.peer = null;
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
