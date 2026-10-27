export interface CallsSetupStatus {
  waba_id?: string;
  phone_number_id?: string;
  calls_webhook_subscribed?: boolean;
  calls_enabled?: boolean;
  calls_callback_permission_status?: string;
  calls_operational_readiness?: {
    ready: boolean;
    checks?: unknown[];
  };
}

export function isCallsSetupReady(
  status: CallsSetupStatus | null | undefined
): boolean {
  if (!status) return false;
  return (
    status.calls_webhook_subscribed === true &&
    status.calls_enabled === true &&
    status.calls_callback_permission_status?.toUpperCase() === "ENABLED" &&
    status.calls_operational_readiness?.ready === true
  );
}
