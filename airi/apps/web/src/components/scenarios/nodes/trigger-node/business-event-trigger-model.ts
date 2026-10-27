export type BusinessEventTriggerField = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "enum";
  options?: readonly { value: string; label: string }[];
};

export type BusinessEventTriggerEvent = {
  id: string;
  name: string;
  fields: readonly BusinessEventTriggerField[];
};

export type BusinessEventTriggerIntegration = {
  id: string;
  name: string;
  events: readonly BusinessEventTriggerEvent[];
};

/** Metadata for editor controls only; this does not enable event execution. */
export type BusinessEventTriggerCatalog = {
  status: "loading" | "error" | "ready";
  integrations: readonly BusinessEventTriggerIntegration[];
};

export const EMPTY_BUSINESS_EVENT_CATALOG: BusinessEventTriggerCatalog = {
  status: "ready",
  integrations: [],
};
