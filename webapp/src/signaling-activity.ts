export type SignalingDirection = "sent" | "received";

export type SignalingMessageType = "sdp-offer" | "sdp-answer" | "ice-candidate" | "status-response";

export interface SignalingActivity {
  sentMessages: number;
  receivedMessages: number;
  sentBytes: number;
  receivedBytes: number;
  lastActivityAt: number;
}

export const emptySignalingActivity = (): SignalingActivity => ({
  sentMessages: 0,
  receivedMessages: 0,
  sentBytes: 0,
  receivedBytes: 0,
  lastActivityAt: 0,
});

export class SignalingActivityTracker {
  private activity = emptySignalingActivity();

  constructor(private readonly onUpdate?: (activity: SignalingActivity) => void) {
    this.emit();
  }

  record(direction: SignalingDirection, type: SignalingMessageType, payload: unknown): void {
    const bytes = payloadByteLength({ type, payload });
    if (direction === "sent") {
      this.activity.sentMessages += 1;
      this.activity.sentBytes += bytes;
    } else {
      this.activity.receivedMessages += 1;
      this.activity.receivedBytes += bytes;
    }
    this.activity.lastActivityAt = Date.now();
    this.emit();
  }

  private emit(): void {
    this.onUpdate?.({ ...this.activity });
  }
}

const payloadByteLength = (payload: unknown): number => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? String(payload);
  } catch {
    serialized = String(payload);
  }
  return new TextEncoder().encode(serialized).byteLength;
};
