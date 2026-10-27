import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import type { Buffer } from "node:buffer";

/** Shared composition contract; the worker owns storage and web owns reply preparation. */
export type WhatsAppVoiceReplyStoragePort = {
  find(ref: {
    workspaceId: string;
    assetId: string;
  }): Promise<ScenarioActionAttachment | null>;
  store(ref: {
    workspaceId: string;
    assetId: string;
    buffer: Buffer;
  }): Promise<ScenarioActionAttachment>;
};

const GLOBAL_PORT_KEY = "__icecoreWhatsAppVoiceReplyStoragePort__" as const;
type StorageGlobal = typeof globalThis & {
  [GLOBAL_PORT_KEY]?: WhatsAppVoiceReplyStoragePort | null;
};

export function configureWhatsAppVoiceReplyStorage(
  port: WhatsAppVoiceReplyStoragePort | null,
): void {
  // Match the creative read-URL port: duplicate module graphs share composition.
  (globalThis as StorageGlobal)[GLOBAL_PORT_KEY] = port;
}

export function getWhatsAppVoiceReplyStorage(): WhatsAppVoiceReplyStoragePort | null {
  return (globalThis as StorageGlobal)[GLOBAL_PORT_KEY] ?? null;
}
