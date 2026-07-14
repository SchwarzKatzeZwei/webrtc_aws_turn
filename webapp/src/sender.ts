import type { SignalingClient } from "amazon-kinesis-video-streams-webrtc";
import type { NatMode } from "./config";
import {
  CONTROL_CHANNEL_LABEL,
  CONTROL_DISCONNECT,
  CONTROL_DISCONNECT_ACK,
} from "./control";
import { prepareKvsConnection, type KvsDestinations } from "./kvs";
import { SignalingActivityTracker, type SignalingActivity } from "./signaling-activity";

export interface SessionCallbacks {
  onLog: (message: string, level?: "info" | "success" | "warn" | "error") => void;
  onSignalingState: (state: string) => void;
  onPeerState: (state: RTCPeerConnectionState, iceState: RTCIceConnectionState) => void;
  onPeerConnection: (connection: RTCPeerConnection | null) => void;
  onDestinations: (destinations: KvsDestinations) => void;
  onSignalingActivity?: (activity: SignalingActivity) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onViewerCount?: (count: number) => void;
  onPeerDisconnected?: (clientId: string, remainingViewerCount: number) => void;
}

export class SenderSession {
  private signalingClient: SignalingClient | null = null;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private stopped = false;

  async start(stream: MediaStream, natMode: NatMode, callbacks: SessionCallbacks): Promise<void> {
    this.stopped = false;
    const activity = new SignalingActivityTracker(callbacks.onSignalingActivity);
    callbacks.onSignalingState("AWS設定を確認中");
    callbacks.onLog("Signaling ChannelとICEサーバーを確認しています");

    const context = await prepareKvsConnection("sender", natMode);
    if (this.stopped) return;
    callbacks.onDestinations(context.destinations);
    this.signalingClient = context.signalingClient;

    this.signalingClient.on("open", () => {
      callbacks.onSignalingState("MASTER待受中");
      callbacks.onLog("MASTERとして接続しました。VIEWERを待っています", "success");
    });

    this.signalingClient.on("sdpOffer", async (offer: RTCSessionDescription, clientId: string) => {
      activity.record("received", "sdp-offer", { offer, clientId });
      try {
        callbacks.onLog(`VIEWER ${clientId} からOfferを受信しました`);
        this.closePeer(clientId);

        const peer = new RTCPeerConnection(context.peerConnectionConfig);
        this.peers.set(clientId, peer);
        callbacks.onViewerCount?.(this.peers.size);
        callbacks.onPeerConnection(peer);

        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        peer.addEventListener("datachannel", ({ channel }) => {
          if (channel.label !== CONTROL_CHANNEL_LABEL) return;
          channel.addEventListener("message", ({ data }) => {
            if (data !== CONTROL_DISCONNECT) return;
            if (channel.readyState === "open") {
              try {
                channel.send(CONTROL_DISCONNECT_ACK);
              } catch {
                // ICEの切断検知がフォールバックになるため、ACK失敗は無視します。
              }
            }
            callbacks.onLog(`VIEWER ${clientId} から切断通知を受信しました`, "warn");
            this.removePeer(clientId, peer, callbacks, 50);
          });
        });
        peer.addEventListener("icecandidate", ({ candidate }) => {
          if (!candidate || !this.signalingClient) return;
          this.signalingClient.sendIceCandidate(candidate, clientId);
          activity.record("sent", "ice-candidate", { candidate, clientId });
        });
        peer.addEventListener("connectionstatechange", () => {
          callbacks.onPeerState(peer.connectionState, peer.iceConnectionState);
          if (peer.connectionState === "connected") {
            callbacks.onLog(`VIEWER ${clientId} と接続しました`, "success");
          }
          if (["failed", "closed"].includes(peer.connectionState)) {
            this.removePeer(clientId, peer, callbacks);
          } else if (peer.connectionState === "disconnected") {
            callbacks.onViewerCount?.(this.peers.size);
          }
        });
        peer.addEventListener("iceconnectionstatechange", () => {
          callbacks.onPeerState(peer.connectionState, peer.iceConnectionState);
        });

        await peer.setRemoteDescription(offer);
        this.signalingClient?.drainPendingIceCandidates(clientId);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (!peer.localDescription) throw new Error("SDP Answerを生成できませんでした。");
        if (!this.signalingClient) return;
        this.signalingClient.sendSdpAnswer(peer.localDescription, clientId);
        activity.record("sent", "sdp-answer", { answer: peer.localDescription, clientId });
      } catch (error) {
        callbacks.onLog(`VIEWER接続処理に失敗しました: ${errorMessage(error)}`, "error");
        this.closePeer(clientId);
      }
    });

    this.signalingClient.on("iceCandidate", (candidate: RTCIceCandidate, clientId: string) => {
      activity.record("received", "ice-candidate", { candidate, clientId });
      const peer = this.peers.get(clientId);
      if (!peer) {
        callbacks.onLog(`未作成のVIEWER ${clientId} のICE candidateを保留しました`, "warn");
        return;
      }
      void peer.addIceCandidate(candidate).catch((error: unknown) => {
        callbacks.onLog(`ICE candidateを追加できませんでした: ${errorMessage(error)}`, "warn");
      });
    });

    this.signalingClient.on("statusResponse", (response: { success?: boolean; description?: string }) => {
      activity.record("received", "status-response", response);
      if (response.success === false) {
        callbacks.onLog(`KVS応答エラー: ${response.description ?? "詳細不明"}`, "error");
      }
    });
    this.signalingClient.on("close", () => callbacks.onSignalingState("切断済み"));
    this.signalingClient.on("error", (error: Error) => {
      callbacks.onSignalingState("シグナリングエラー");
      callbacks.onLog(`シグナリングエラー: ${error.message}`, "error");
    });

    callbacks.onSignalingState("接続中");
    this.signalingClient.open();
  }

  stop(): void {
    this.stopped = true;
    this.signalingClient?.close();
    this.signalingClient?.removeAllListeners();
    this.signalingClient = null;
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
  }

  private closePeer(clientId: string): void {
    this.peers.get(clientId)?.close();
    this.peers.delete(clientId);
  }

  private removePeer(
    clientId: string,
    peer: RTCPeerConnection,
    callbacks: SessionCallbacks,
    closeDelayMs = 0,
  ): void {
    if (this.peers.get(clientId) !== peer) return;
    this.peers.delete(clientId);
    const remainingViewerCount = this.peers.size;
    const nextPeer = this.peers.values().next().value ?? null;
    callbacks.onViewerCount?.(remainingViewerCount);
    callbacks.onPeerConnection(nextPeer);
    callbacks.onPeerDisconnected?.(clientId, remainingViewerCount);
    if (closeDelayMs > 0) window.setTimeout(() => peer.close(), closeDelayMs);
    else peer.close();
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
