export type CandidatePath = "host" | "srflx" | "relay" | "prflx" | "unknown";

export interface CandidateEndpoint {
  type: CandidatePath;
  address: string;
  port: number | null;
  protocol: string;
  relayProtocol: string;
  networkType: string;
  url: string;
}

export interface WebRtcStats {
  path: CandidatePath;
  local: CandidateEndpoint;
  remote: CandidateEndpoint;
  pairState: string;
  rttMs: number | null;
  bitrateKbps: number | null;
  packetLossPercent: number | null;
  bytesTransferred: number;
}

const emptyEndpoint = (): CandidateEndpoint => ({
  type: "unknown",
  address: "",
  port: null,
  protocol: "",
  relayProtocol: "",
  networkType: "",
  url: "",
});

export const emptyWebRtcStats = (): WebRtcStats => ({
  path: "unknown",
  local: emptyEndpoint(),
  remote: emptyEndpoint(),
  pairState: "new",
  rttMs: null,
  bitrateKbps: null,
  packetLossPercent: null,
  bytesTransferred: 0,
});

type StatsRecord = RTCStats & Record<string, unknown>;

export class StatsMonitor {
  private timer: number | null = null;
  private previousBytes = 0;
  private previousTimestamp = 0;

  start(peer: RTCPeerConnection, direction: "inbound" | "outbound", onUpdate: (stats: WebRtcStats) => void): void {
    this.stop();
    const sample = async (): Promise<void> => {
      try {
        const report = await peer.getStats();
        onUpdate(this.parse(report, direction));
      } catch {
        onUpdate(emptyWebRtcStats());
      }
    };
    void sample();
    this.timer = window.setInterval(() => void sample(), 1000);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.previousBytes = 0;
    this.previousTimestamp = 0;
  }

  private parse(report: RTCStatsReport, direction: "inbound" | "outbound"): WebRtcStats {
    const records = new Map<string, StatsRecord>();
    report.forEach((value) => records.set(value.id, value as StatsRecord));

    let pair: StatsRecord | undefined;
    for (const record of records.values()) {
      if (record.type === "transport" && typeof record.selectedCandidatePairId === "string") {
        pair = records.get(record.selectedCandidatePairId);
      }
    }
    if (!pair) {
      pair = [...records.values()].find((record) =>
        record.type === "candidate-pair" && record.state === "succeeded" && (record.nominated === true || record.selected === true),
      );
    }

    const local = pair && typeof pair.localCandidateId === "string" ? records.get(pair.localCandidateId) : undefined;
    const remote = pair && typeof pair.remoteCandidateId === "string" ? records.get(pair.remoteCandidateId) : undefined;
    const localEndpoint = candidateEndpoint(local);
    const remoteEndpoint = candidateEndpoint(remote);
    const path = pathType(localEndpoint.type, remoteEndpoint.type);

    let bytes = 0;
    let timestamp = 0;
    let packetsLost = 0;
    let packetsReceived = 0;
    const mediaType = direction === "inbound" ? "inbound-rtp" : "outbound-rtp";
    for (const record of records.values()) {
      if (record.type !== mediaType || record.isRemote === true) continue;
      const byteField = direction === "inbound" ? record.bytesReceived : record.bytesSent;
      bytes += numberValue(byteField);
      timestamp = Math.max(timestamp, numberValue(record.timestamp));
      if (direction === "inbound") {
        packetsLost += numberValue(record.packetsLost);
        packetsReceived += numberValue(record.packetsReceived);
      }
    }
    if (direction === "outbound") {
      for (const record of records.values()) {
        if (record.type !== "remote-inbound-rtp") continue;
        packetsLost += numberValue(record.packetsLost);
        packetsReceived += numberValue(record.packetsReceived);
      }
    }

    let bitrateKbps: number | null = null;
    if (this.previousTimestamp > 0 && timestamp > this.previousTimestamp) {
      bitrateKbps = ((bytes - this.previousBytes) * 8) / (timestamp - this.previousTimestamp);
    }
    this.previousBytes = bytes;
    this.previousTimestamp = timestamp;

    const totalPackets = packetsLost + packetsReceived;
    return {
      path,
      local: localEndpoint,
      remote: remoteEndpoint,
      pairState: stringValue(pair?.state) || "new",
      rttMs: pair && typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
      bitrateKbps: bitrateKbps !== null && bitrateKbps >= 0 ? bitrateKbps : null,
      packetLossPercent: totalPackets > 0 ? (packetsLost / totalPackets) * 100 : null,
      bytesTransferred: bytes,
    };
  }
}

const candidateEndpoint = (record: StatsRecord | undefined): CandidateEndpoint => {
  const rawType = stringValue(record?.candidateType);
  return {
    type: isCandidatePath(rawType) ? rawType : "unknown",
    address: stringValue(record?.address) || stringValue(record?.ip) || stringValue(record?.ipAddress),
    port: nullableNumber(record?.port),
    protocol: stringValue(record?.protocol),
    relayProtocol: stringValue(record?.relayProtocol),
    networkType: stringValue(record?.networkType),
    url: stringValue(record?.url),
  };
};

const isCandidatePath = (value: string): value is CandidatePath => {
  return value === "host" || value === "srflx" || value === "relay" || value === "prflx";
};

const pathType = (local: CandidatePath, remote: CandidatePath): CandidatePath => {
  if (local === "relay" || remote === "relay") return "relay";
  if (local === "srflx" || remote === "srflx") return "srflx";
  if (local === "prflx" || remote === "prflx") return "prflx";
  if (local === "host" || remote === "host") return "host";
  return "unknown";
};

const numberValue = (value: unknown): number => typeof value === "number" ? value : 0;
const nullableNumber = (value: unknown): number | null => typeof value === "number" ? value : null;
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
