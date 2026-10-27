import type { CustomerContactPolicy } from "@icecore/scenario-contracts";
import {
  JSON_HEADERS,
  NO_STORE_OPTIONS,
  readResponseJson,
  errorMessageOrFallback,
} from "./http";

export type CustomerBehaviorPanelData = {
  policy: CustomerContactPolicy;
  runs: {
    _id: string;
    config: { preset: string };
    dueAt: string;
    status: string;
    reason?: string;
    referenceId: string;
  }[];
};
function url(workspaceId: string, conversationId?: string) {
  return `/api/scenarios/customer-behavior?${new URLSearchParams({ workspaceId, ...(conversationId ? { conversationId } : {}) })}`;
}
export async function fetchCustomerBehavior(
  workspaceId: string,
  conversationId?: string
): Promise<CustomerBehaviorPanelData> {
  const response = await fetch(
    url(workspaceId, conversationId),
    NO_STORE_OPTIONS
  );
  const body = await readResponseJson(response);
  if (!response.ok)
    throw new Error(
      errorMessageOrFallback(body, "Customer journeys unavailable")
    );
  return body as CustomerBehaviorPanelData;
}
export async function saveCustomerBehaviorEvent(
  workspaceId: string,
  event: {
    eventId: string;
    eventType: string;
    conversationId: string;
    referenceId: string;
    occurredAt: string;
    dueAt?: string;
  }
) {
  const response = await fetch(url(workspaceId), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(event),
  });
  if (!response.ok)
    throw new Error(
      errorMessageOrFallback(
        await readResponseJson(response),
        "Customer event could not be saved"
      )
    );
}
export async function saveCustomerContactPolicy(
  workspaceId: string,
  policy: CustomerContactPolicy
) {
  const response = await fetch(url(workspaceId), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(policy),
  });
  if (!response.ok)
    throw new Error(
      errorMessageOrFallback(
        await readResponseJson(response),
        "Contact policy could not be saved"
      )
    );
}
