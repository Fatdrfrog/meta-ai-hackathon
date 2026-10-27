import { firstEnv } from "./env";

export type TemporalConnectionEnv = {
  address: string;
  namespace: string;
  apiKey: string | null;
  tls: boolean;
};

export const TEMPORAL_TLS_API_KEY_REQUIRED_MESSAGE =
  "TEMPORAL_API_KEY or TEMPORAL_CLOUD_API_KEY is required when using Temporal Cloud or a TLS Temporal endpoint";

/** Whether TEMPORAL_ADDRESS/TEMPORAL_CLOUD_ADDRESS and a namespace are set. */
export function hasTemporalConnectionEnv(): boolean {
  return Boolean(
    firstEnv("TEMPORAL_ADDRESS", "TEMPORAL_CLOUD_ADDRESS") &&
      firstEnv("TEMPORAL_NAMESPACE", "TEMPORAL_CLOUD_NAMESPACE"),
  );
}

/**
 * The Temporal connection settings shared by web, worker and OTP runtimes.
 * TEMPORAL_* wins over TEMPORAL_CLOUD_*; TLS is on with an API key or for a
 * *.api.temporal.io address.
 */
export function resolveTemporalConnectionEnv(): TemporalConnectionEnv {
  const address =
    firstEnv("TEMPORAL_ADDRESS", "TEMPORAL_CLOUD_ADDRESS") || "localhost:7233";
  const namespace =
    firstEnv("TEMPORAL_NAMESPACE", "TEMPORAL_CLOUD_NAMESPACE") || "default";
  const apiKey = firstEnv("TEMPORAL_API_KEY", "TEMPORAL_CLOUD_API_KEY");
  const tls = Boolean(apiKey) || /\.api\.temporal\.io(?::\d+)?$/i.test(address);
  return { address, namespace, apiKey, tls };
}

/** Throws `message` when TLS is required but no API key is configured. */
export function assertTemporalTlsApiKey(
  connection: TemporalConnectionEnv,
  message: string = TEMPORAL_TLS_API_KEY_REQUIRED_MESSAGE,
): void {
  if (connection.tls && !connection.apiKey) {
    throw new Error(message);
  }
}
