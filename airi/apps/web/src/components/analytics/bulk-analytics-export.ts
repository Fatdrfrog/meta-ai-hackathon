import { formatWhatsAppDisplayId } from "@/lib/date-utils";

export type BulkAnalyticsExportLabels = {
  sheets: {
    summary: string;
    templates: string;
    daily: string;
    outcomes: string;
    failures: string;
    runs: string;
    topConversations: string;
    records: string;
  };
  columns: {
    metric: string;
    current: string;
    previous: string;
    template: string;
    accepted: string;
    replied: string;
    replyRate: string;
    date: string;
    outcome: string;
    count: string;
    error: string;
    hour: string;
    recipient: string;
    conversationId: string;
    sentAt: string;
    status: string;
    replies: string;
    firstReply: string;
    deliveryStatus?: string;
    deliveryErrorCode?: string;
    deliveredAt?: string;
    readAt?: string;
    providerRecipient?: string;
    recipientConflict?: string;
  };
  status: {
    replied: string;
    noReply: string;
  };
  metrics: Array<{ key: string; label: string }>;
};

export type BulkAnalyticsExportWorkbookInput = {
  generatedAt: string;
  window: {
    startDate: string;
    endDate: string;
    replyWindowHours: number;
  };
  summary?: {
    totalAccepted: number;
    uniqueConversations: number;
    replied: number;
    notReplied: number;
    totalReplies: number;
    replyRate: number;
    read?: number | null;
    readRate?: number | null;
    delivered?: number | null;
    deliveryRate?: number | null;
    failed?: number | null;
    failedRate?: number | null;
    estimatedCost?: number | null;
    costPerReply?: number | null;
    avgReplyDelayMinutes: number | null;
  } | null;
  compareSummary?: {
    totalAccepted: number;
    uniqueConversations: number;
    replied: number;
    notReplied: number;
    totalReplies: number;
    replyRate: number;
    read?: number | null;
    readRate?: number | null;
    delivered?: number | null;
    deliveryRate?: number | null;
    failed?: number | null;
    failedRate?: number | null;
    estimatedCost?: number | null;
    costPerReply?: number | null;
    avgReplyDelayMinutes: number | null;
  } | null;
  byTemplate: Array<{
    templateName: string;
    accepted: number;
    replied: number;
    replyRate: number;
  }>;
  daily: Array<{
    date: string;
    accepted: number;
    replied: number;
    replyRate: number;
  }>;
  outcomes: Array<{ bucket: string; count: number }>;
  failures: Array<{ errorCode: string; count: number }>;
  detectedRuns: Array<{
    templateName: string;
    bucket: string;
    accepted: number;
    replyRate: number;
  }>;
  topConversations: Array<{
    conversationId: string;
    recipient: string;
    templateName: string;
    replyCount: number;
    firstReplyText: string;
  }>;
  records: Array<{
    conversationId: string;
    recipient: string;
    templateName: string;
    sentAt: string;
    replied: boolean;
    replyCount: number;
    firstReplyText: string;
    deliveryStatus?: string | null;
    deliveryErrorCode?: string | null;
    deliveredAt?: string | null;
    readAt?: string | null;
    providerRecipient?: string | null;
    recipientConflict?: boolean;
  }>;
  exportContext?: {
    filters: string;
    observedAt: string;
    completedAt: string;
    complete: boolean;
    consistency: string;
  };
  deliveryStatusLabel?: (status: string) => string;
  labels: BulkAnalyticsExportLabels;
  outcomeLabel: (bucket: string) => string;
};

const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_EXPORT_RECORDS = 50_000;

export type BulkAnalyticsExportCollection<T> = {
  records: T[];
  observedAt: string;
  completedAt: string;
};

/** Collect a complete filtered audience, never a success-shaped partial page. */
export async function collectAllBulkAnalyticsRecords<
  T extends { id: string },
>(options: {
  url: string;
  observedAt?: string;
  snapshotToken?: string;
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
  maxRecords?: number;
  expectedCount?: number;
}): Promise<BulkAnalyticsExportCollection<T>> {
  const base = new URL(
    options.url,
    typeof window === "undefined" ? "http://localhost" : window.location.origin
  );
  base.searchParams.set("view", "records");
  base.searchParams.set("compare", "off");
  base.searchParams.set("limit", "100");
  base.searchParams.delete("cursor");
  if (options.observedAt)
    base.searchParams.set("observedAt", options.observedAt);
  if (options.snapshotToken)
    base.searchParams.set("snapshotToken", options.snapshotToken);

  const maxRecords = Math.min(
    MAX_EXPORT_RECORDS,
    Math.max(1, Math.floor(options.maxRecords || MAX_EXPORT_RECORDS))
  );
  const rows: T[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let observedAt =
    options.observedAt || base.searchParams.get("observedAt") || "";
  let snapshotToken =
    options.snapshotToken || base.searchParams.get("snapshotToken") || "";

  for (;;) {
    options.signal?.throwIfAborted();
    const response = await fetch(base.toString(), { signal: options.signal });
    const page = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(page?.error || "Could not collect the complete export");
    }
    if (
      !page ||
      !Array.isArray(page.records) ||
      !page.pageInfo ||
      typeof page.pageInfo.hasMore !== "boolean" ||
      page.dataQuality?.complete !== true
    ) {
      throw new Error("Export data is incomplete. Refresh and try again.");
    }
    const pageObservation = page.dataQuality?.observedAt;
    const pageSnapshot = page.snapshotToken || page.dataQuality?.snapshotToken;
    if (
      typeof pageObservation !== "string" ||
      !Number.isFinite(Date.parse(pageObservation)) ||
      typeof pageSnapshot !== "string" ||
      !pageSnapshot
    ) {
      throw new Error(
        "The export observation is unavailable. Refresh and try again."
      );
    }
    if (observedAt && pageObservation && pageObservation !== observedAt) {
      throw new Error("The export observation changed. Refresh and try again.");
    }
    observedAt ||= pageObservation;
    if (snapshotToken && pageSnapshot && snapshotToken !== pageSnapshot) {
      throw new Error("The export snapshot changed. Refresh and try again.");
    }
    snapshotToken ||= pageSnapshot || "";
    base.searchParams.set("observedAt", observedAt);
    if (snapshotToken) base.searchParams.set("snapshotToken", snapshotToken);

    for (const row of page.records as T[]) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)) {
        throw new Error("The export contains duplicate or invalid rows.");
      }
      if (rows.length >= maxRecords) {
        throw new Error(
          `Export is limited to ${maxRecords.toLocaleString()} rows. Narrow the filters.`
        );
      }
      ids.add(row.id);
      rows.push(row);
    }
    options.onProgress?.(rows.length);

    if (!page.pageInfo.hasMore) break;
    const cursor = page.pageInfo.nextCursor;
    if (
      typeof cursor !== "string" ||
      !cursor ||
      cursors.has(cursor) ||
      page.records.length === 0
    ) {
      throw new Error("The export could not advance to the next page.");
    }
    cursors.add(cursor);
    base.searchParams.set("cursor", cursor);
  }
  options.signal?.throwIfAborted();
  if (
    typeof options.expectedCount === "number" &&
    rows.length !== options.expectedCount
  ) {
    throw new Error(
      "The recipient count changed. Refresh and try the export again."
    );
  }
  return { records: rows, observedAt, completedAt: new Date().toISOString() };
}

export function formatBulkAnalyticsRecipientLabel(value: string): string {
  const trimmed = value.trim();
  return formatWhatsAppDisplayId(trimmed) || trimmed;
}

function sanitizeExcelCell(value: unknown): string | number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }
  if (value == null) return "";
  const text = String(value);
  if (/^[=+\-@\t\r]/.test(text) || text.startsWith("\n")) {
    return `'${text}`;
  }
  return text;
}

function sheetName(value: string): string {
  const cleaned = value.replace(/[:\\/?*[\]]/g, " ").trim() || "Sheet";
  return cleaned.slice(0, 31);
}

function summaryValue(
  summary:
    | NonNullable<BulkAnalyticsExportWorkbookInput["summary"]>
    | null
    | undefined,
  key: string
): number | null {
  if (!summary) return null;
  const value = (summary as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

export async function buildBulkAnalyticsWorkbook(
  input: BulkAnalyticsExportWorkbookInput
): Promise<Uint8Array> {
  const { utils, write } = await import("xlsx");
  const workbook = utils.book_new();
  const { labels } = input;

  const appendSheet = (name: string, rows: unknown[][]) => {
    if (rows.length <= 1) return;
    const worksheet = utils.aoa_to_sheet(
      rows.map(row => row.map(sanitizeExcelCell))
    );
    utils.book_append_sheet(workbook, worksheet, sheetName(name));
  };

  const summaryRows: unknown[][] = [
    ["window", input.window.startDate, input.window.endDate],
    ["generatedAt", input.generatedAt, input.window.replyWindowHours],
    [labels.columns.metric, labels.columns.current, labels.columns.previous],
  ];
  for (const metric of labels.metrics) {
    summaryRows.push([
      metric.label,
      summaryValue(input.summary, metric.key),
      summaryValue(input.compareSummary, metric.key),
    ]);
  }
  if (input.exportContext) {
    summaryRows.push(
      ["filters", input.exportContext.filters],
      ["observedAt", input.exportContext.observedAt],
      ["collectionCompletedAt", input.exportContext.completedAt],
      ["complete", input.exportContext.complete ? 1 : 0],
      ["consistency", input.exportContext.consistency],
      ["exportedRows", input.records.length]
    );
  }
  appendSheet(labels.sheets.summary, summaryRows);

  appendSheet(labels.sheets.templates, [
    [
      labels.columns.template,
      labels.columns.accepted,
      labels.columns.replied,
      labels.columns.replyRate,
    ],
    ...input.byTemplate.map(row => [
      row.templateName,
      row.accepted,
      row.replied,
      row.replyRate,
    ]),
  ]);

  appendSheet(labels.sheets.daily, [
    [
      labels.columns.date,
      labels.columns.accepted,
      labels.columns.replied,
      labels.columns.replyRate,
    ],
    ...input.daily.map(row => [
      row.date,
      row.accepted,
      row.replied,
      row.replyRate,
    ]),
  ]);

  appendSheet(labels.sheets.outcomes, [
    [labels.columns.outcome, labels.columns.count],
    ...input.outcomes.map(row => [input.outcomeLabel(row.bucket), row.count]),
  ]);

  appendSheet(labels.sheets.failures, [
    [labels.columns.error, labels.columns.count],
    ...input.failures.map(row => [row.errorCode, row.count]),
  ]);

  appendSheet(labels.sheets.runs, [
    [
      labels.columns.hour,
      labels.columns.template,
      labels.columns.accepted,
      labels.columns.replyRate,
    ],
    ...input.detectedRuns.map(row => [
      row.bucket,
      row.templateName,
      row.accepted,
      row.replyRate,
    ]),
  ]);

  appendSheet(labels.sheets.topConversations, [
    [
      labels.columns.recipient,
      labels.columns.template,
      labels.columns.replies,
      labels.columns.firstReply,
    ],
    ...input.topConversations.map(row => [
      formatBulkAnalyticsRecipientLabel(row.recipient || row.conversationId),
      row.templateName,
      row.replyCount,
      row.firstReplyText,
    ]),
  ]);

  const deliveryColumns = labels.columns.deliveryStatus
    ? [
        labels.columns.deliveryStatus,
        labels.columns.deliveryErrorCode || "Delivery error code",
        labels.columns.deliveredAt || "Delivered at",
        labels.columns.readAt || "Read at",
        labels.columns.providerRecipient || "Provider recipient",
        labels.columns.recipientConflict || "Recipient conflict",
      ]
    : [];
  appendSheet(labels.sheets.records, [
    [
      labels.columns.sentAt,
      labels.columns.recipient,
      labels.columns.conversationId,
      labels.columns.template,
      labels.columns.replied,
      labels.columns.status,
      labels.columns.replies,
      labels.columns.firstReply,
      ...deliveryColumns,
    ],
    ...input.records.map(row => [
      row.sentAt,
      formatBulkAnalyticsRecipientLabel(row.recipient || row.conversationId),
      row.conversationId,
      row.templateName,
      row.replied ? 1 : 0,
      row.replied ? labels.status.replied : labels.status.noReply,
      row.replyCount,
      row.firstReplyText,
      ...(deliveryColumns.length
        ? [
            input.deliveryStatusLabel?.(row.deliveryStatus || "unknown") ||
              row.deliveryStatus ||
              "unknown",
            row.deliveryErrorCode,
            row.deliveredAt,
            row.readAt,
            row.providerRecipient,
            row.recipientConflict ? 1 : 0,
          ]
        : []),
    ]),
  ]);

  const raw = write(workbook, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer | Uint8Array;

  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

export function downloadBulkAnalyticsWorkbook(
  bytes: Uint8Array,
  filename: string
) {
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  const blob = new Blob([payload], { type: EXCEL_CONTENT_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
