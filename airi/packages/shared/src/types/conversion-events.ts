/** Verified commerce events are supplied by an authenticated merchant system. */
export type CommerceEventInput = {
  eventId: string;
  eventType: "purchase" | "refund";
  transactionId: string;
  purchaseTransactionId?: string;
  conversationId: string;
  orderId?: string;
  value: number;
  currency: string;
  occurredAt: string;
};

export type MetaConversionDeliveryStatus =
  | "not_eligible"
  | "pending"
  | "queued"
  | "delivery_unknown"
  | "sent"
  | "rejected";

/** The exact payment wait a confirmed sale may resolve; never a later wait. */
export type ConfirmedPaymentScenarioSnapshot = {
  sourceId: string;
  scenarioId: string;
  scenarioUpdatedAt: string;
  pendingConditionNodeId: string;
  pendingSourceActionNodeId: string;
  pendingStartedAt: string;
  pendingLastOutboundMessageId: string;
  occurredAt: string;
};

export type WhatsAppConversionsConfiguration = {
  enabled: boolean;
  dataset_id: string;
  waba_id: string;
  configured_at: string;
  /** Reject referrals captured before the source last changed WhatsApp account. */
  attribution_boundary_at?: string;
  test_event_code?: string | null;
};

/** Immutable delivery destination and facts; never contains a token or receipt. */
export type MetaConversionSnapshot = {
  sourceId: string;
  datasetId: string;
  wabaId: string;
  ctwaClid: string;
  eventName: "Purchase" | "OrderReturned";
  eventTime: number;
  value: number;
  currency: string;
  testEventCode?: string;
};

export type ConversionAttributionRow = {
  adId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  currency: string;
  sales: number;
  refunds: number;
  grossRevenue: number;
  refundedRevenue: number;
  netRevenue: number;
  payingCustomers: number;
  paidConversations: number;
};

export type ConversionDeliverySummary = {
  id: string;
  conversionType: string;
  value: number | null;
  currency: string | null;
  occurredAt: string;
  status: MetaConversionDeliveryStatus;
  reason: string | null;
  testMode: boolean;
};

export type ConversionAttributionReport = {
  rows: ConversionAttributionRow[];
  recentDeliveries: ConversionDeliverySummary[];
  truncated: boolean;
};

/** Recorded ledger outcomes; a Flow submission or AI guess is not a booking. */
export type ScenarioConversionReport = {
  scenarioId: string;
  period: { startDate: string; endDate: string };
  totals: { sales: number; bookings: number; signups: number; refunds: number };
  currencies: Array<{
    /** Empty for historical records without a valid currency code. */
    currency: string;
    sales: number;
    refunds: number;
    grossRevenue: number;
    refundedRevenue: number;
    netRevenue: number;
  }>;
  /** Counts remain complete when the currency breakdown exceeds its limit. */
  truncated: boolean;
};
