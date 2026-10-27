import { isCustomerBirthdayFieldName } from "@/lib/customers/customer-birthday";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";
import { isValidCampaignEmailAddress } from "@/lib/campaign/campaign-recipient-utils";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  isExcelSpreadsheetFile,
  normalizeSpreadsheetCell,
  normalizeSpreadsheetHeader,
  readCsvRows,
  readExcelSheet,
  SpreadsheetReadError,
  toNumberedNonEmptyRows,
} from "@/lib/spreadsheet/read-rows";

export type RecipientUploadChannel = "whatsapp" | "telegram" | "email";

export type UploadRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  birthday?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export type RecipientUploadMessages = {
  emptyFile: string;
  whatsappMissingPhone: string;
  whatsappBirthdayMissingColumns: string;
  telegramMissingChatId: string;
  telegramBirthdayMissingColumns: string;
  emailMissingAddress: string;
  noValidRecipients: string;
  maxRecipientsExceeded: string;
  whatsappInvalidPhone?: (row: number) => string;
  invalidCsv?: string;
};

export type RecipientUploadParseOptions = {
  channel: RecipientUploadChannel;
  templateVariables?: string[];
  recipientLimit?: number;
  requireBirthdayColumn?: boolean;
  messages: RecipientUploadMessages;
};

/** Why a row was left out of the audience instead of failing the file. */
export type SkippedUploadRowReason =
  | "missing_recipient"
  | "invalid_phone"
  | "invalid_email";

export type SkippedUploadRow = {
  /** The row number as the spreadsheet shows it. */
  row: number;
  value: string;
  reason: SkippedUploadRowReason;
};

export type ParsedRecipientUpload = {
  recipients: UploadRecipient[];
  variableMapping: Record<string, string>;
  originalRecipientCount: number;
  recipientLimit: number;
  truncated: boolean;
  /** Excel rows left out because Excel hides them (an Excel filter does). */
  hiddenRowCount: number;
  /** Rows without a usable recipient, in file order. */
  skippedRows: SkippedUploadRow[];
};

export const DEFAULT_RECIPIENT_LIMIT = MAX_BULK_CAMPAIGN_RECIPIENTS;

function escapeCsvCell(value: string): string {
  // A leading formula character is neutralized so the sheet can't run it.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The skipped rows as a CSV the user can download and fix. */
export function buildSkippedUploadRowsCsv(
  rows: SkippedUploadRow[],
  labels: {
    columns: { row: string; value: string; reason: string };
    reasons: Record<SkippedUploadRowReason, string>;
  }
): string {
  const lines = [
    [labels.columns.row, labels.columns.value, labels.columns.reason],
    ...rows.map(row => [
      String(row.row),
      row.value,
      labels.reasons[row.reason],
    ]),
  ];
  return lines.map(line => line.map(escapeCsvCell).join(",")).join("\r\n");
}

export const isExcelRecipientUpload = isExcelSpreadsheetFile;

export function parseCsvRecipientUpload(
  text: string,
  options: RecipientUploadParseOptions
): ParsedRecipientUpload {
  let parsed: ReturnType<typeof readCsvRows>;
  try {
    parsed = readCsvRows(text);
  } catch {
    // Parser errors can contain cell contents; expose only the localized error.
    throw new Error(
      options.messages.invalidCsv || options.messages.noValidRecipients
    );
  }
  return parseRecipientRows(parsed.rows, options, parsed.sourceRowNumbers);
}

export async function parseExcelRecipientUpload(
  buffer: ArrayBuffer,
  options: RecipientUploadParseOptions
): Promise<ParsedRecipientUpload> {
  let sheet: Awaited<ReturnType<typeof readExcelSheet>>;
  try {
    // Formatted text keeps dates and phones as the user sees them. Rows an
    // Excel filter hides are not part of the audience the user sees.
    sheet = await readExcelSheet(buffer, { raw: false, skipHiddenRows: true });
  } catch (error) {
    if (error instanceof SpreadsheetReadError) {
      throw new Error(options.messages.emptyFile);
    }
    throw error;
  }

  return {
    ...parseRecipientRows(sheet.rows, options),
    hiddenRowCount: sheet.hiddenRowCount,
  };
}

export function parseRecipientRows(
  rows: unknown[][],
  {
    channel,
    templateVariables = [],
    messages,
    recipientLimit = DEFAULT_RECIPIENT_LIMIT,
    requireBirthdayColumn = false,
  }: RecipientUploadParseOptions,
  sourceRowNumbers?: number[]
): ParsedRecipientUpload {
  const effectiveRecipientLimit = normalizeRecipientLimit(recipientLimit);
  const nonEmptyRows = toNumberedNonEmptyRows(rows, sourceRowNumbers);

  if (nonEmptyRows.length === 0) {
    throw new Error(messages.emptyFile);
  }

  const header = nonEmptyRows[0].values.map(cell =>
    normalizeSpreadsheetHeader(cell)
  );
  const birthdayIndex = header.findIndex(h => isCustomerBirthdayFieldName(h));

  let recipientIndex = -1;
  if (channel === "whatsapp") {
    recipientIndex = header.findIndex(h =>
      ["phone", "phone_number", "mobile", "whatsapp"].includes(h)
    );
    if (
      requireBirthdayColumn &&
      (recipientIndex === -1 || birthdayIndex === -1)
    ) {
      throw new Error(messages.whatsappBirthdayMissingColumns);
    }
    if (recipientIndex === -1) {
      throw new Error(messages.whatsappMissingPhone);
    }
  } else if (channel === "telegram") {
    const chatIdIndex = header.findIndex(h =>
      ["chat_id", "chatid", "telegram_id"].includes(h)
    );
    recipientIndex =
      chatIdIndex !== -1 ? chatIdIndex : header.findIndex(h => h === "phone");
    if (requireBirthdayColumn && (chatIdIndex === -1 || birthdayIndex === -1)) {
      throw new Error(messages.telegramBirthdayMissingColumns);
    }
    if (recipientIndex === -1) {
      throw new Error(messages.telegramMissingChatId);
    }
  } else if (channel === "email") {
    recipientIndex = header.findIndex(h =>
      ["email", "email_address", "mail"].includes(h)
    );
    if (recipientIndex === -1) {
      throw new Error(messages.emailMissingAddress);
    }
  }

  const recipientColumnName = header[recipientIndex];
  const nameIndex = header.findIndex(h =>
    ["name", "full_name", "customer_name", "first_name", "имя", "фио"].includes(
      h
    )
  );
  const emailIndex = header.findIndex(h =>
    ["email", "email_address", "e_mail", "mail", "электронная_почта"].includes(
      h
    )
  );
  const { indexByVariable, labelByVariable } = resolveVariableMapping(
    header,
    recipientIndex,
    templateVariables,
    channel
  );

  const recipients: UploadRecipient[] = [];
  const skippedRows: SkippedUploadRow[] = [];
  const variableColumns = header.filter((_, index) => index !== recipientIndex);

  for (let i = 1; i < nonEmptyRows.length; i++) {
    const { values: rowValues, rowNumber } = nonEmptyRows[i];
    const values = rowValues.map(cell => normalizeSpreadsheetCell(cell).trim());
    const recipientValue = values[recipientIndex];

    // A row with other cells but no recipient is reported, not dropped
    // silently, so the user can fix their file.
    if (!recipientValue) {
      skippedRows.push({
        row: rowNumber,
        value: "",
        reason: "missing_recipient",
      });
      continue;
    }

    const fields: Record<string, string> = {};
    const variables: Record<string, string> = {};

    header.forEach((column, index) => {
      if (index === recipientIndex) return;
      const value = values[index];
      if (value) fields[column] = value;
    });

    if (templateVariables.length > 0 && channel === "whatsapp") {
      templateVariables.forEach(varNum => {
        const mappedIndex = indexByVariable[varNum];
        const value = values[mappedIndex];
        if (mappedIndex !== undefined && value) {
          variables[varNum] = value;
        }
      });
    } else {
      variableColumns.forEach((col, idx) => {
        const actualIndex = idx >= recipientIndex ? idx + 1 : idx;
        const value = values[actualIndex];
        if (value) variables[col] = value;
      });
    }

    const recipientData: UploadRecipient = {
      name:
        nameIndex !== -1 && values[nameIndex] ? values[nameIndex] : undefined,
      ...(birthdayIndex !== -1 && values[birthdayIndex]
        ? { birthday: values[birthdayIndex] }
        : {}),
      fields: Object.keys(fields).length > 0 ? fields : undefined,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    };

    if (channel === "whatsapp") {
      const normalizedPhone = normalizeWhatsAppPhone(recipientValue);
      if (!normalizedPhone) {
        skippedRows.push({
          row: rowNumber,
          value: recipientValue,
          reason: "invalid_phone",
        });
        continue;
      }
      recipientData.phone = /^'?\+/.test(recipientValue)
        ? `+${normalizedPhone}`
        : normalizedPhone;
      if (emailIndex !== -1 && values[emailIndex]) {
        recipientData.email = values[emailIndex].toLowerCase();
      }
    } else if (channel === "telegram") {
      const isChatIdColumn = ["chat_id", "chatid", "telegram_id"].includes(
        recipientColumnName
      );
      if (isChatIdColumn) {
        recipientData.chatId = recipientValue;
      } else {
        recipientData.phone = recipientValue;
      }
    } else if (channel === "email") {
      if (!isValidCampaignEmailAddress(recipientValue)) {
        skippedRows.push({
          row: rowNumber,
          value: recipientValue,
          reason: "invalid_email",
        });
        continue;
      }
      recipientData.email = recipientValue.toLowerCase();
    }

    recipients.push(recipientData);
  }

  if (recipients.length === 0) {
    // With nothing to send, name the first bad phone so it can be fixed.
    const firstInvalidPhone = skippedRows.find(
      row => row.reason === "invalid_phone"
    );
    throw new Error(
      (firstInvalidPhone &&
        messages.whatsappInvalidPhone?.(firstInvalidPhone.row)) ||
        messages.noValidRecipients
    );
  }

  const originalRecipientCount = recipients.length;
  const truncated = originalRecipientCount > effectiveRecipientLimit;
  const acceptedRecipients = truncated
    ? recipients.slice(0, effectiveRecipientLimit)
    : recipients;

  return {
    recipients: acceptedRecipients,
    variableMapping: labelByVariable,
    originalRecipientCount,
    recipientLimit: effectiveRecipientLimit,
    truncated,
    hiddenRowCount: 0,
    skippedRows,
  };
}

function resolveVariableMapping(
  header: string[],
  recipientIndex: number,
  templateVariables: string[],
  channel: RecipientUploadChannel
): {
  indexByVariable: Record<string, number>;
  labelByVariable: Record<string, string>;
} {
  const indexByVariable: Record<string, number> = {};
  const labelByVariable: Record<string, string> = {};

  if (templateVariables.length === 0 || channel !== "whatsapp") {
    return { indexByVariable, labelByVariable };
  }

  templateVariables.forEach(varNum => {
    const foundIndex = header.findIndex(
      (h, index) =>
        index !== recipientIndex && headerNamesTemplateVariable(h, varNum)
    );

    if (foundIndex !== -1) {
      indexByVariable[varNum] = foundIndex;
      labelByVariable[varNum] = header[foundIndex];
    }
  });

  return { indexByVariable, labelByVariable };
}

function headerNamesTemplateVariable(header: string, varNum: string): boolean {
  const prefixedNames = [
    `var${varNum}`,
    `var_${varNum}`,
    `variable${varNum}`,
    `variable_${varNum}`,
  ];
  if (!/^\d+$/.test(varNum)) {
    // Named variables keep the loose match.
    return [...prefixedNames, varNum, `{{${varNum}}}`].some(
      name => header === name || header.includes(name)
    );
  }
  // A bare number only names the variable on its own or in braces: "1",
  // "{1}" and "{{ 1 }}" (normalized to "{{_1_}}") are {{1}}, but "адрес_1",
  // "phone1" or "2021" are not, and "var10" is not var1.
  if (header.replace(/[{}]/g, "").replace(/^_+|_+$/g, "") === varNum) {
    return true;
  }
  // Braces also name it inside a longer header, such as "{{1}}_имя".
  if (new RegExp(`\\{_?${varNum}_?\\}`).test(header)) return true;
  return prefixedNames.some(name => {
    const at = header.indexOf(name);
    return at !== -1 && !/\d/.test(header.charAt(at + name.length));
  });
}

function normalizeRecipientLimit(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RECIPIENT_LIMIT;
  }
  return Math.floor(parsed);
}
