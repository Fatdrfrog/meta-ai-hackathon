import "server-only";

import {
  dispatchWhatsAppServiceMessage,
  type DispatchWhatsAppServiceMessageInput,
  type WhatsAppServiceMessageTransport,
} from "@/lib/airi/reply/delivery/whatsapp-service-message";
import { resolveWhatsAppServiceCommandMediaForSend } from "@/lib/airi/reply/delivery/whatsapp-service-message-media";
import * as whatsappApi from "@/lib/whatsapp";
import type { WhatsAppServiceSendCommand } from "@icecore/scenario-contracts";

export type SendWhatsAppServiceMessageInput =
  DispatchWhatsAppServiceMessageInput & {
    workspaceId?: string | null;
  };

type SendWhatsAppServiceMessageResult = Awaited<
  ReturnType<typeof dispatchWhatsAppServiceMessage>
> & {
  /** Command after object-URL → HTTPS prep (use for previews / primaryMedia). */
  preparedCommand: WhatsAppServiceSendCommand;
};

/**
 * Delivery orchestration: resolve object URLs → HTTPS, then Meta transport.
 * Worker / web both use this; read-URL port is wired at composition root.
 */
export async function sendWhatsAppServiceMessage(
  input: SendWhatsAppServiceMessageInput,
  transport: WhatsAppServiceMessageTransport = whatsappApi
): Promise<SendWhatsAppServiceMessageResult> {
  const preparedCommand = await resolveWhatsAppServiceCommandMediaForSend(
    input.command,
    input.workspaceId
  );
  const result = await dispatchWhatsAppServiceMessage(
    {
      phoneNumberId: input.phoneNumberId,
      accessToken: input.accessToken,
      sourceId: input.sourceId,
      wabaId: input.wabaId,
      recipient: input.recipient,
      command: preparedCommand,
      beforeSend: input.beforeSend,
    },
    transport
  );
  return {
    ...result,
    preparedCommand,
  };
}
