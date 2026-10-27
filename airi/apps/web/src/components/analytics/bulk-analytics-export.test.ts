import { read, utils } from "xlsx";
import { parseRecipientRows } from "@/components/campaigns/recipient-upload-parser";
import { parseWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  buildBulkAnalyticsWorkbook,
  formatBulkAnalyticsRecipientLabel,
} from "./bulk-analytics-export";

const labels = {
  sheets: {
    summary: "Summary",
    templates: "Templates",
    daily: "Daily",
    outcomes: "Outcomes",
    failures: "Failures",
    runs: "Runs",
    topConversations: "Most active replies",
    records: "Records",
  },
  columns: {
    metric: "Metric",
    current: "Current",
    previous: "Previous",
    template: "Template",
    accepted: "Accepted",
    replied: "Replied",
    replyRate: "Reply rate",
    date: "Date",
    outcome: "Outcome",
    count: "Count",
    error: "Error",
    hour: "Hour",
    recipient: "Recipient",
    conversationId: "Conversation",
    sentAt: "Sent",
    status: "Status",
    replies: "Replies",
    firstReply: "First reply",
  },
  status: {
    replied: "Replied",
    noReply: "No reply",
  },
  metrics: [{ key: "totalAccepted", label: "Accepted" }],
};

describe("bulk analytics excel export", () => {
  it("round-trips exported plus-prefixed phones through campaign upload", async () => {
    const bytes = await buildBulkAnalyticsWorkbook({
      generatedAt: "2026-09-18T00:00:00.000Z",
      window: {
        startDate: "2026-09-01T00:00:00.000Z",
        endDate: "2026-09-18T00:00:00.000Z",
        replyWindowHours: 24,
      },
      byTemplate: [],
      daily: [],
      outcomes: [],
      failures: [],
      detectedRuns: [],
      topConversations: [
        {
          conversationId: "fixture",
          recipient: "+77001234567",
          templateName: "promo",
          replyCount: 0,
          firstReplyText: "=1+1",
        },
      ],
      records: [],
      labels,
      outcomeLabel: bucket => bucket,
    });
    const workbook = read(bytes, { type: "array" });
    const rows = utils.sheet_to_json<string[]>(
      workbook.Sheets[labels.sheets.topConversations],
      { header: 1, raw: false }
    );
    expect(rows[1][0]).toBe("'+77001234567");
    expect(rows[1][3]).toBe("'=1+1");
    const imported = parseRecipientRows([["phone"], [rows[1][0]]], {
      channel: "whatsapp",
      messages: {
        emptyFile: "empty",
        whatsappMissingPhone: "phone",
        whatsappBirthdayMissingColumns: "birthday",
        telegramMissingChatId: "chat",
        telegramBirthdayMissingColumns: "birthday",
        emailMissingAddress: "email",
        noValidRecipients: "none",
        maxRecipientsExceeded: "max",
      },
    });
    expect(imported.recipients[0].phone).toBe("+77001234567");
    expect(parseWhatsAppRecipientTarget(imported.recipients[0].phone)).toEqual({
      kind: "phone",
      value: "77001234567",
    });
  });

  it("strips wa_ from recipient labels", () => {
    expect(formatBulkAnalyticsRecipientLabel("wa_77001234567")).toBe(
      "77001234567"
    );
    expect(formatBulkAnalyticsRecipientLabel("wa_bsuid_user-1")).toBe("user-1");
  });

  it("writes recipients without wa_ and guards formula-like reply text", async () => {
    const bytes = await buildBulkAnalyticsWorkbook({
      generatedAt: "2026-09-03T12:00:00.000Z",
      window: {
        startDate: "2026-08-20T00:00:00.000Z",
        endDate: "2026-09-03T00:00:00.000Z",
        replyWindowHours: 168,
      },
      summary: {
        totalAccepted: 12,
        uniqueConversations: 10,
        replied: 4,
        notReplied: 8,
        totalReplies: 5,
        replyRate: 0.33,
        avgReplyDelayMinutes: 9,
      },
      compareSummary: null,
      byTemplate: [],
      daily: [],
      outcomes: [],
      failures: [],
      detectedRuns: [],
      topConversations: [
        {
          conversationId: "conv-1",
          recipient: "wa_77001234567",
          templateName: "promo",
          replyCount: 3,
          firstReplyText: "=1+1",
        },
      ],
      records: [
        {
          conversationId: "conv-1",
          recipient: "wa_77001234567",
          templateName: "promo",
          sentAt: "2026-09-01T10:00:00.000Z",
          replied: true,
          replyCount: 3,
          firstReplyText: "=cmd",
        },
      ],
      labels,
      outcomeLabel: bucket => bucket,
    });

    const workbook = read(bytes, { type: "array" });
    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining(["Summary", "Most active replies", "Records"])
    );

    const replies = utils.sheet_to_json<string[]>(
      workbook.Sheets["Most active replies"],
      { header: 1 }
    );
    expect(replies[1]?.[0]).toBe("77001234567");
    expect(replies[1]?.[3]).toBe("'=1+1");

    const records = utils.sheet_to_json<string[]>(workbook.Sheets.Records, {
      header: 1,
    });
    expect(records[1]?.[1]).toBe("77001234567");
    expect(records[1]?.[4]).toBe(1);
    expect(records[1]?.[5]).toBe("Replied");
    expect(records[1]?.[7]).toBe("'=cmd");

    const summary = utils.sheet_to_json<Array<string | number>>(
      workbook.Sheets.Summary,
      { header: 1 }
    );
    expect(summary.some(row => row[0] === "Accepted" && row[1] === 12)).toBe(
      true
    );
  });

  it("writes replied counts on the summary sheet", async () => {
    const bytes = await buildBulkAnalyticsWorkbook({
      generatedAt: "2026-09-03T12:00:00.000Z",
      window: {
        startDate: "2026-08-20T00:00:00.000Z",
        endDate: "2026-09-03T00:00:00.000Z",
        replyWindowHours: 168,
      },
      summary: {
        totalAccepted: 12,
        uniqueConversations: 10,
        replied: 4,
        notReplied: 8,
        totalReplies: 5,
        replyRate: 0.33,
        avgReplyDelayMinutes: 9,
      },
      compareSummary: null,
      byTemplate: [],
      daily: [],
      outcomes: [],
      failures: [],
      detectedRuns: [],
      topConversations: [],
      records: [],
      labels: {
        ...labels,
        metrics: [
          { key: "totalAccepted", label: "Accepted" },
          { key: "replied", label: "Replied" },
          { key: "notReplied", label: "Not replied" },
        ],
      },
      outcomeLabel: bucket => bucket,
    });

    const workbook = read(bytes, { type: "array" });
    const summary = utils.sheet_to_json<Array<string | number>>(
      workbook.Sheets.Summary,
      { header: 1 }
    );
    expect(summary.some(row => row[0] === "Replied" && row[1] === 4)).toBe(
      true
    );
  });
});
