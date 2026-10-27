"use client";

import useSWR from "swr";

type ActionErrorKey =
  | "actionError"
  | "expiryError"
  | "permissionsError"
  | "keyLimitError"
  | "webhookLimitError"
  | "endpointError"
  | "accessError";

class CustomerApiSettingsError extends Error {
  constructor(readonly displayKey: ActionErrorKey) {
    super(displayKey);
  }
}

export function customerApiActionError(error: unknown): ActionErrorKey {
  return error instanceof CustomerApiSettingsError
    ? error.displayKey
    : "actionError";
}

export async function customerApiJson<T>(
  url: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const reason = typeof payload?.error === "string" ? payload.error : "";
    let displayKey: ActionErrorKey = "actionError";
    if (response.status === 401 || response.status === 403)
      displayKey = "accessError";
    else if (reason === "Expiry must be in the future")
      displayKey = "expiryError";
    else if (reason === "Select at least one permission")
      displayKey = "permissionsError";
    else if (response.status === 409 && reason.includes("100 active keys"))
      displayKey = "keyLimitError";
    else if (response.status === 409 && /20 active webhooks/i.test(reason))
      displayKey = "webhookLimitError";
    else if (response.status === 400 && /webhook (url|host)/i.test(reason))
      displayKey = "endpointError";
    throw new CustomerApiSettingsError(displayKey);
  }
  return response.json() as Promise<T>;
}

export function useCustomerApiResource<T>(url: string | null) {
  return useSWR<T>(url, customerApiJson<T>, { shouldRetryOnError: false });
}
