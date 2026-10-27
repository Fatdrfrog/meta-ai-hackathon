import {
  buildWhatsAppFlowEndpointTopology,
  parseWhatsAppFlowEndpointTopology,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";

const TOKEN_PREFIX = "airi1.";
const MAX_ENCODED_TOKEN_LENGTH =
  TOKEN_PREFIX.length + Math.ceil((16_384 * 4) / 3);

export type WhatsAppFlowEndpointTokenV1 = {
  v: 1;
  screens: string[];
  routing: Record<string, string[]>;
  branches?: Record<string, Record<string, Record<string, string>>>;
};

/** Legacy-only airi1 token shape consumed by the existing endpoint handler. */
export function encodeFlowEndpointToken(
  payload: WhatsAppFlowEndpointTokenV1
): string {
  const topology = parseWhatsAppFlowEndpointTopology({
    version: payload.v,
    initialScreenId: payload.screens[0],
    screens: payload.screens,
    routing: payload.routing,
    branches: payload.branches ?? {},
  });
  const canonicalPayload: WhatsAppFlowEndpointTokenV1 = {
    v: 1,
    screens: [...topology.screens],
    routing: Object.fromEntries(
      Object.entries(topology.routing).map(([screenId, targets]) => [
        screenId,
        [...targets],
      ])
    ),
    ...(Object.keys(topology.branches).length > 0
      ? { branches: topology.branches }
      : {}),
  };
  const json = Buffer.from(
    serializeCanonicalJson(canonicalPayload),
    "utf8"
  ).toString("base64url");
  return TOKEN_PREFIX + json;
}

export function decodeFlowEndpointToken(
  flowToken: string
): WhatsAppFlowEndpointTokenV1 | null {
  const t = flowToken.trim();
  if (!t.startsWith(TOKEN_PREFIX)) return null;
  if (t.length > MAX_ENCODED_TOKEN_LENGTH) return null;
  try {
    const encoded = t.slice(TOKEN_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const rawBuffer = Buffer.from(encoded, "base64url");
    if (rawBuffer.byteLength > 16_384) return null;
    const raw = rawBuffer.toString("utf8");
    const o = JSON.parse(raw) as Partial<WhatsAppFlowEndpointTokenV1>;
    const topology = parseWhatsAppFlowEndpointTopology({
      version: o?.v,
      initialScreenId: o?.screens?.[0],
      screens: o?.screens,
      routing: o?.routing,
      branches: o?.branches ?? {},
    });
    return {
      v: 1,
      screens: [...topology.screens],
      routing: Object.fromEntries(
        Object.entries(topology.routing).map(([screenId, targets]) => [
          screenId,
          [...targets],
        ])
      ),
      ...(Object.keys(topology.branches).length > 0
        ? { branches: topology.branches }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Build flow_token for Data Endpoint flows (multi-screen + data_endpoint mode).
 * Returns null for linear-only configs; invalid endpoint configs are rejected.
 */
export function buildFlowEndpointTokenFromConfig(
  config: WhatsAppFlowConfig | null | undefined
): string | null {
  if (
    config &&
    Object.prototype.hasOwnProperty.call(config, "providerReference")
  ) {
    return null;
  }
  const s = sanitizeWhatsAppFlowConfig(config ?? null);
  if (!s || s.flowNavigationMode !== "data_endpoint") {
    return null;
  }
  const topology = buildWhatsAppFlowEndpointTopology(s);
  const payload: WhatsAppFlowEndpointTokenV1 = {
    v: topology.version,
    screens: [...topology.screens],
    routing: Object.fromEntries(
      Object.entries(topology.routing).map(([screenId, targets]) => [
        screenId,
        [...targets],
      ])
    ),
    ...(Object.keys(topology.branches).length > 0
      ? { branches: topology.branches }
      : {}),
  };
  return encodeFlowEndpointToken(payload);
}
