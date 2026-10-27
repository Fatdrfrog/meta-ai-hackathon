/**
 * Shared intent for provider CSAT query writers (web routes and the WhatsApp
 * runtime). Lifecycle timestamps remain owned by the conversation source hook.
 */
export function customerCsatResolutionFields() {
  return {
    service_resolution_kind: "customer_csat" as const,
    csat_timeout_closed: false,
  };
}
