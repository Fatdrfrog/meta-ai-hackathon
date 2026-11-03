import type { GraphApiErrorBody } from "@icecore/shared/types/whatsapp";

export async function parseGraphResponse<T = unknown>(
  res: Response
): Promise<T> {
  const raw = await res.text();
  if (!raw) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Meta's Graph API answered a template mutation (or one of its header
 * uploads) with a refusal: the message is Meta's own words, as
 * formatGraphApiError writes them. Anything else a create can throw (a
 * timeout, the account not resolving, a header that couldn't be fetched)
 * is airi's side, not Meta refusing.
 */
export class WhatsAppTemplateGraphRefusalError extends Error {
  readonly status: number;
  readonly graphError: GraphApiErrorBody | undefined;

  constructor(
    message: string,
    status: number,
    graphError: GraphApiErrorBody | undefined
  ) {
    super(message);
    this.name = "WhatsAppTemplateGraphRefusalError";
    this.status = status;
    this.graphError = graphError;
  }
}

export function formatGraphApiError(
  error: GraphApiErrorBody | undefined,
  fallback: string
): string {
  const errorParts: string[] = [];
  if (error?.message?.trim()) {
    errorParts.push(error.message.trim());
  }
  if (error?.error_user_msg?.trim()) {
    errorParts.push(error.error_user_msg.trim());
  }
  if (error?.error_data?.details?.trim()) {
    errorParts.push(error.error_data.details.trim());
  }

  return errorParts.length > 0 ? errorParts.join(" - ") : fallback;
}
