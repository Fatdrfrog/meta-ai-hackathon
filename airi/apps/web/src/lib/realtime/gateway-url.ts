export function getRealtimeGatewayUrl(
  env: Record<string, string | undefined> = process.env,
  fallback = ""
): string {
  return String(
    env.REALTIME_GATEWAY_URL || env.NEXT_PUBLIC_REALTIME_GATEWAY_URL || fallback
  ).trim();
}
