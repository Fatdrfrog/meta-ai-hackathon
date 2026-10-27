import { readEnvOrEmpty as readEnv } from "@icecore/shared/lib/env";
import { createClient, type RedisClientType } from "redis";

export type RealtimeValkeyClient = RedisClientType;

function getValkeySocket() {
  const host = readEnv("MEMORYSTORE_VALKEY_HOST");
  if (!host) {
    throw new Error("MEMORYSTORE_VALKEY_HOST is required");
  }
  const parsedPort = Number.parseInt(
    readEnv("MEMORYSTORE_VALKEY_PORT") || "6379",
    10,
  );
  const parsedTimeout = Number.parseInt(
    readEnv("MEMORYSTORE_VALKEY_TIMEOUT_MS") || "5000",
    10,
  );

  return {
    host,
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 6379,
    connectTimeout:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 5000,
    tls: /^(1|true|yes)$/i.test(readEnv("MEMORYSTORE_VALKEY_TLS")) || undefined,
  };
}

export function createRealtimeValkeyClient(): RealtimeValkeyClient {
  const url = readEnv("MEMORYSTORE_VALKEY_URL");
  const password = readEnv("MEMORYSTORE_VALKEY_AUTH_TOKEN");

  if (url) {
    return createClient({
      url,
      password: password || undefined,
    }) as RealtimeValkeyClient;
  }

  return createClient({
    socket: getValkeySocket(),
    password: password || undefined,
  }) as RealtimeValkeyClient;
}

export async function connectRealtimeValkeyClient(
  client: RealtimeValkeyClient,
): Promise<RealtimeValkeyClient> {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
