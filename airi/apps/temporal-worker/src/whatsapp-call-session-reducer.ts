import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import * as WhatsAppCallSessionModule from "@/models/whatsapp-call-session";
import type { WhatsAppCallSessionDocument } from "@/models/whatsapp-call-session";

import {
  createWhatsAppCallSessionReducer,
  deriveWhatsAppCallSessionState,
  WHATSAPP_CALL_SESSION_STATES,
  type WhatsAppCallSessionReducerDependencies,
  type WhatsAppCallSessionState,
} from "./whatsapp-call-session-reducer-core.js";

export {
  createWhatsAppCallSessionReducer,
  deriveWhatsAppCallSessionState,
  WHATSAPP_CALL_SESSION_STATES,
  type WhatsAppCallSessionReducerDependencies,
  type WhatsAppCallSessionState,
  type WhatsAppCallSessionDocument,
};

// Same unwrap as the call linker: the CommonJS web model arrives as a module
// wrapper under the ESM worker.
const WhatsAppCallSession = readDefaultExport<
  typeof WhatsAppCallSessionModule.default
>(WhatsAppCallSessionModule);

export const upsertWhatsAppCallSessionFromEvent =
  createWhatsAppCallSessionReducer<WhatsAppCallSessionDocument>({
    whatsAppCallSessionModel: WhatsAppCallSession,
  });
