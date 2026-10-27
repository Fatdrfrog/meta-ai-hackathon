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
