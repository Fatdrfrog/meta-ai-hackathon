import type { CampaignVariableSourceConfig } from "@icecore/scenario-contracts";

export type CampaignRecipientLike = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  sourceId?: string | null;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export function normalizeCampaignVariableFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

export function collectCampaignRecipientColumns(
  recipients: CampaignRecipientLike[]
): string[] {
  const keys = new Set<string>();
  recipients.forEach(recipient =>
    Object.keys(recipient.fields || {}).forEach(key => keys.add(key))
  );
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

export function retainCampaignVariableConfigs(params: {
  templateVariables: string[];
  previous: Record<string, CampaignVariableSourceConfig>;
}): Record<string, CampaignVariableSourceConfig> {
  const next: Record<string, CampaignVariableSourceConfig> = {};
  params.templateVariables.forEach(variable => {
    next[variable] = params.previous[variable] || { mode: "auto" };
  });
  return next;
}

/**
 * Where a variable's value came from. `phone_fallback` means auto mode found
 * no value or name for it and used the recipient's phone instead.
 */
export type CampaignVariableValueSource =
  | "csv_variable"
  | "csv_column"
  | "contact_name"
  | "recipient_phone"
  | "custom"
  | "phone_fallback"
  | "none";

export function resolveCampaignVariableValue(
  variable: string,
  recipient: CampaignRecipientLike,
  config: CampaignVariableSourceConfig
): string {
  return resolveCampaignVariableValueWithSource(variable, recipient, config)
    .value;
}

type NormalizeFieldKey = (key: string) => string;

/** Remembers normalized keys, which repeat on every row of a file. */
function createFieldKeyNormalizer(): NormalizeFieldKey {
  const cache = new Map<string, string>();
  return key => {
    let normalized = cache.get(key);
    if (normalized === undefined) {
      normalized = normalizeCampaignVariableFieldKey(key);
      cache.set(key, normalized);
    }
    return normalized;
  };
}

function normalizeRecipientFields(
  recipient: CampaignRecipientLike,
  normalizeKey: NormalizeFieldKey
): Map<string, string> {
  const normalizedFields = new Map<string, string>();
  for (const [key, value] of Object.entries(recipient.fields || {})) {
    normalizedFields.set(normalizeKey(key), value);
  }
  return normalizedFields;
}

export function resolveCampaignVariableValueWithSource(
  variable: string,
  recipient: CampaignRecipientLike,
  config: CampaignVariableSourceConfig
): { value: string; source: CampaignVariableValueSource } {
  return resolveFromNormalizedFields(
    variable,
    recipient,
    config,
    normalizeRecipientFields(recipient, normalizeCampaignVariableFieldKey),
    normalizeCampaignVariableFieldKey
  );
}

function resolveFromNormalizedFields(
  variable: string,
  recipient: CampaignRecipientLike,
  config: CampaignVariableSourceConfig,
  normalizedFields: ReadonlyMap<string, string>,
  normalizeKey: NormalizeFieldKey
): { value: string; source: CampaignVariableValueSource } {
  const variableKey = variable.trim();
  const normalizedVariable = normalizeKey(variableKey);

  const fromFields = (...keys: string[]) => {
    for (const key of keys) {
      const value = normalizedFields.get(normalizeKey(key));
      if (value && value.trim().length > 0) return value.trim();
    }
    return "";
  };

  const fromVariableMap = recipient.variables?.[variableKey]?.trim() || "";
  const fromCsvVariable = (
    fromVariableMap ||
    fromFields(
      variableKey,
      normalizedVariable,
      `var${variableKey}`,
      `var_${variableKey}`,
      `variable${variableKey}`,
      `variable_${variableKey}`
    )
  ).trim();

  const contactName =
    recipient.name?.trim() ||
    fromFields("name", "full_name", "first_name", "customer_name");
  const recipientPhone = (recipient.phone || recipient.chatId || "").trim();

  const from = (
    value: string,
    source: Exclude<CampaignVariableValueSource, "none">
  ) => ({
    value,
    source: value ? source : ("none" as const),
  });

  if (config.mode === "csv_variable") {
    return from(fromCsvVariable, "csv_variable");
  }
  if (config.mode === "csv_column") {
    return from(
      config.csvColumn ? fromFields(config.csvColumn) : "",
      "csv_column"
    );
  }
  if (config.mode === "contact_name") return from(contactName, "contact_name");
  if (config.mode === "recipient_phone") {
    return from(recipientPhone, "recipient_phone");
  }
  if (config.mode === "custom") {
    return from(config.customValue?.trim() || "", "custom");
  }

  if (fromCsvVariable) return from(fromCsvVariable, "csv_variable");
  if (/name/i.test(variableKey) && contactName) {
    return from(contactName, "contact_name");
  }
  if (/(phone|chat|number)/i.test(variableKey) && recipientPhone) {
    return from(recipientPhone, "recipient_phone");
  }
  if (/^\d+$/.test(variableKey)) {
    const numericKey = Number.parseInt(variableKey, 10);
    if (numericKey === 1 && contactName) {
      return from(contactName, "contact_name");
    }
    if (numericKey === 2 && recipientPhone) {
      return from(recipientPhone, "recipient_phone");
    }
  }
  if (contactName) return from(contactName, "contact_name");
  return from(recipientPhone, "phone_fallback");
}

export type CampaignAutoVariablePreview = {
  firstValue: string;
  phoneFallbackCount: number;
};

const AUTO_VARIABLE_CONFIG: CampaignVariableSourceConfig = { mode: "auto" };

/**
 * What each auto-filled variable sends: the first recipient's value, and how
 * many recipients get their phone because they have no name. One pass over
 * the recipients serves every variable; empty without recipients.
 */
export function previewCampaignAutoVariableValues(params: {
  variables: readonly string[];
  recipients: readonly CampaignRecipientLike[];
}): Map<string, CampaignAutoVariablePreview> {
  const previews = new Map<string, CampaignAutoVariablePreview>();
  if (params.recipients.length === 0) return previews;
  params.variables.forEach(variable =>
    previews.set(variable, { firstValue: "", phoneFallbackCount: 0 })
  );
  if (previews.size === 0) return previews;
  const normalizeKey = createFieldKeyNormalizer();
  params.recipients.forEach((recipient, index) => {
    const normalizedFields = normalizeRecipientFields(recipient, normalizeKey);
    previews.forEach((preview, variable) => {
      const resolved = resolveFromNormalizedFields(
        variable,
        recipient,
        AUTO_VARIABLE_CONFIG,
        normalizedFields,
        normalizeKey
      );
      if (index === 0) preview.firstValue = resolved.value;
      if (resolved.source === "phone_fallback") preview.phoneFallbackCount += 1;
    });
  });
  return previews;
}

export function resolveCampaignVariablesForRecipient(params: {
  recipient: CampaignRecipientLike;
  templateVariables: string[];
  variableConfigs: Record<string, CampaignVariableSourceConfig>;
}): {
  recipient: CampaignRecipientLike;
  missingVariables: string[];
} {
  const resolved: Record<string, string> = {};

  params.templateVariables.forEach(variable => {
    const value = resolveCampaignVariableValue(
      variable,
      params.recipient,
      params.variableConfigs[variable] || { mode: "auto" }
    );
    if (value) resolved[variable] = value;
  });

  const missingVariables = params.templateVariables.filter(
    variable => !resolved[variable]
  );

  return {
    recipient: {
      ...params.recipient,
      variables: Object.keys(resolved).length > 0 ? resolved : undefined,
    },
    missingVariables,
  };
}
