import "server-only";

import {
  createServerLogger,
  type ServerLogContext,
} from "@/lib/observability/server-logs";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { updateCurrentWhatsAppSourceCredentialsFromSnapshot } from "@/lib/whatsapp/flows/source-rebind-guard";
import { resolveWhatsAppSourceByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";
import { createWhatsAppPhoneNumberUsernameUpdateHandler } from "@icecore/airi-runtime/whatsapp-phone-number-username";

const logger = createServerLogger("whatsapp.phone-number-username");
function toServerLogContext(
  context?: Record<string, unknown>
): ServerLogContext | undefined {
  return context as ServerLogContext | undefined;
}

const phoneNumberUsernameLogger = {
  info: (message: string, context?: Record<string, unknown>) =>
    logger.info(message, toServerLogContext(context)),
  warn: (message: string, context?: Record<string, unknown>) =>
    logger.warn(message, toServerLogContext(context)),
  error: (
    message: string,
    error?: Error | unknown,
    context?: Record<string, unknown>
  ) => logger.error(message, error, toServerLogContext(context)),
};

export const handlePhoneNumberUsernameUpdate =
  createWhatsAppPhoneNumberUsernameUpdateHandler({
    findWhatsAppSourceByDisplayPhoneNumber: displayPhoneNumber =>
      fetchSourceWithCredentials(undefined, "whatsapp", {
        "credentials->>display_phone_number": displayPhoneNumber,
      }),
    logger: phoneNumberUsernameLogger,
    now: () => new Date(),
    resolveWhatsAppSourceByAccountIdentifiers:
      resolveWhatsAppSourceByAccountIdentifiers,
    updateSourceCredentials: async params => {
      try {
        await updateCurrentWhatsAppSourceCredentialsFromSnapshot({
          workspaceId: params.workspaceId,
          sourceId: params.sourceId,
          currentCredentials: params.currentCredentials,
          nextCredentials: params.credentials,
        });
        return { error: null };
      } catch (error) {
        return { error };
      }
    },
  });
