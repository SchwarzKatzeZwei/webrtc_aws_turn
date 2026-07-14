export type AppMode = "sender" | "receiver";
export type NatMode = "p2p" | "turn";

export interface AppConfig {
  region: string;
  channelName: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

const readEnv = (name: keyof ImportMetaEnv): string => import.meta.env[name]?.trim() ?? "";

export const appConfig: AppConfig = {
  region: readEnv("VITE_AWS_REGION"),
  channelName: readEnv("VITE_KVS_CHANNEL_NAME"),
  credentials: {
    accessKeyId: readEnv("VITE_AWS_ACCESS_KEY_ID"),
    secretAccessKey: readEnv("VITE_AWS_SECRET_ACCESS_KEY"),
    sessionToken: import.meta.env.VITE_AWS_SESSION_TOKEN?.trim() || undefined,
  },
};

export const validateAppConfig = (): void => {
  const missing = [
    ["VITE_AWS_REGION", appConfig.region],
    ["VITE_KVS_CHANNEL_NAME", appConfig.channelName],
    ["VITE_AWS_ACCESS_KEY_ID", appConfig.credentials.accessKeyId],
    ["VITE_AWS_SECRET_ACCESS_KEY", appConfig.credentials.secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} が未設定です。webapp/.env.local を確認してください。`);
  }
};

export const readMode = (): AppMode => {
  const value = new URLSearchParams(window.location.search).get("mode");
  return value === "receiver" ? "receiver" : "sender";
};

export const makeViewerClientId = (): string => {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `viewer-${random[0]?.toString(16)}${random[1]?.toString(16)}`.slice(0, 64);
};
