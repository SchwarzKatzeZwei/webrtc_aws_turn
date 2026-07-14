import {
  DescribeSignalingChannelCommand,
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
  type ResourceEndpointListItem,
} from "@aws-sdk/client-kinesis-video";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
import {
  Role,
  SignalingClient,
} from "amazon-kinesis-video-streams-webrtc";
import { appConfig, type AppMode, type NatMode } from "./config";

export interface KvsConnectionContext {
  channelArn: string;
  signalingClient: SignalingClient;
  peerConnectionConfig: RTCConfiguration;
  destinations: KvsDestinations;
}

export interface KvsDestinations {
  region: string;
  signalingUrl: string;
  signalingHost: string;
  turnHosts: string[];
}

const endpointMap = (items: ResourceEndpointListItem[] | undefined): Record<string, string> => {
  return (items ?? []).reduce<Record<string, string>>((result, item) => {
    if (item.Protocol && item.ResourceEndpoint) {
      result[item.Protocol] = item.ResourceEndpoint;
    }
    return result;
  }, {});
};

const destinationHost = (url: string): string => {
  try {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") || url.startsWith("wss://")) {
      return new URL(url).hostname;
    }
    const withoutScheme = url.replace(/^[a-z]+:/i, "").replace(/^\/\//, "");
    const bracketedIpv6 = withoutScheme.match(/^\[([^\]]+)\]/)?.[1];
    if (bracketedIpv6) return bracketedIpv6;
    return withoutScheme.split(/[?:/]/)[0] ?? withoutScheme;
  } catch {
    return url;
  }
};

export const prepareKvsConnection = async (
  mode: AppMode,
  natMode: NatMode,
  viewerClientId?: string,
): Promise<KvsConnectionContext> => {
  const role = mode === "sender" ? Role.MASTER : Role.VIEWER;
  const kvsClient = new KinesisVideoClient({
    region: appConfig.region,
    credentials: appConfig.credentials,
  });

  const channel = await kvsClient.send(
    new DescribeSignalingChannelCommand({ ChannelName: appConfig.channelName }),
  );
  const channelArn = channel.ChannelInfo?.ChannelARN;
  if (!channelArn) {
    throw new Error(`Signaling Channel「${appConfig.channelName}」のARNを取得できませんでした。`);
  }

  const endpointResponse = await kvsClient.send(
    new GetSignalingChannelEndpointCommand({
      ChannelARN: channelArn,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: ["WSS", "HTTPS"],
        Role: mode === "sender" ? "MASTER" : "VIEWER",
      },
    }),
  );
  const endpoints = endpointMap(endpointResponse.ResourceEndpointList);
  if (!endpoints.WSS || !endpoints.HTTPS) {
    throw new Error("KVSのWSS/HTTPSエンドポイントを取得できませんでした。");
  }

  const signalingApi = new KinesisVideoSignalingClient({
    region: appConfig.region,
    endpoint: endpoints.HTTPS,
    credentials: appConfig.credentials,
  });
  const iceResponse = await signalingApi.send(
    new GetIceServerConfigCommand({
      ChannelARN: channelArn,
      ClientId: mode === "receiver" ? viewerClientId : undefined,
    }),
  );

  const turnServers: RTCIceServer[] = (iceResponse.IceServerList ?? []).map((server) => ({
    urls: server.Uris ?? [],
    username: server.Username,
    credential: server.Password,
  }));
  const turnHosts = [...new Set(turnServers.flatMap((server) => {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    return urls.map(destinationHost).filter(Boolean);
  }))];
  if (natMode === "turn" && turnServers.length === 0) {
    throw new Error("TURNサーバー設定を取得できなかったため、TURN強制接続を開始できません。 ");
  }

  const iceServers: RTCIceServer[] = natMode === "turn"
    ? turnServers
    : [
        { urls: `stun:stun.kinesisvideo.${appConfig.region}.amazonaws.com:443` },
        ...turnServers,
      ];

  const signalingClient = new SignalingClient({
    channelARN: channelArn,
    channelEndpoint: endpoints.WSS,
    clientId: mode === "receiver" ? viewerClientId : undefined,
    role,
    region: appConfig.region,
    credentials: appConfig.credentials,
    enableEarlyIceCandidateBuffering: true,
  });

  return {
    channelArn,
    signalingClient,
    destinations: {
      region: appConfig.region,
      signalingUrl: endpoints.WSS,
      signalingHost: destinationHost(endpoints.WSS),
      turnHosts,
    },
    peerConnectionConfig: {
      iceServers,
      iceTransportPolicy: natMode === "turn" ? "relay" : "all",
      bundlePolicy: "max-bundle",
    },
  };
};
