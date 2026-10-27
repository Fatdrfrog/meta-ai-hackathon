// Fixtures and query doubles shared by the Coach route and background-job
// classification freshness suites.

import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS } from "@icecore/shared/lib/conversation-classification-freshness";
import { readyClassificationFields } from "@/lib/classifier/classified-conversation-test-utils";

export const sourceMessage = {
  _id: "message-1",
  text: "Can you explain the pricing?",
  direction: "inbound",
  date: new Date("2026-08-10T12:00:00.000Z"),
};

export const customerProfile = {
  _id: "customer-1",
  displayName: "Customer Ada",
  status: "active",
  currentFunnelStage: "manual-stage",
  profileSummary: {
    conversationCount: 2,
    tags: ["customer-owned-tag"],
    lastSentiment: null,
  },
};

/** A Coach-enabled conversation classified at revision 7, plus manual context. */
export function buildCurrentConversation(
  overrides: Record<string, unknown> = {}
) {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "whatsapp",
    preferred_language: "en",
    airi_coach_enabled: true,
    customerId: "customer-1",
    status: "open",
    classification: {
      category: "classifier-category",
      priority: "classifier-priority",
      sentiment: "classifier-sentiment",
      tags: ["classifier-tag"],
      summary: "classifier-summary",
      action: "classifier-action",
    },
    ...readyClassificationFields(7),
    internal_labels: ["manual-label"],
    quick_note: "manager-only-note",
    ...overrides,
  };
}

export function createSelectLeanQuery<T>(
  value: T,
  onSelect?: (value: string) => void
) {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.select.mockImplementation((selection: string) => {
    onSelect?.(selection);
    return query;
  });
  query.lean.mockResolvedValue(value);
  return query;
}

export function createMessageListQuery(messages: unknown[]) {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockResolvedValue(messages);
  return query;
}

export function expectCanonicalSelect(select: string) {
  const selected = select.split(/\s+/u).filter(Boolean);
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    expect(selected.filter(value => value === path)).toHaveLength(1);
  }
}

/** The prompt window drops every classifier value but keeps manual context. */
export function expectClassificationOmittedWithManualContext(
  window: string,
  conversationSelect: string
) {
  expect(window).not.toContain("- Classification:");
  for (const classifierValue of [
    "classifier-category",
    "classifier-priority",
    "classifier-sentiment",
    "classifier-tag",
    "classifier-summary",
    "classifier-action",
  ]) {
    expect(window).not.toContain(classifierValue);
  }
  expect(window).toContain("manual-label");
  expect(window).toContain("manager-only-note");
  expect(window).toContain("Customer Ada");
  expect(window).toContain("customer-owned-tag");
  expectCanonicalSelect(conversationSelect);
}
