/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import mockRuMessages from "../../../messages/conversations/ru/page.json";
import { ConversationInfo } from "./conversation-info";
import type { ConversationInfoDetails } from "./conversation-info-view-model";

function getRuConversationMessage(key: string): string {
  const conversationMessages =
    mockRuMessages.ConversationDetailView as unknown as Record<string, unknown>;
  const value = conversationMessages[key];

  return typeof value === "string" ? value : key;
}

jest.mock("next-intl", () => {
  function getValue(messages: Record<string, unknown>, key: string): unknown {
    return key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        messages
      );
  }

  return {
    useLocale: () => "ru",
    useTranslations:
      (namespace: string) =>
      (key: string): string => {
        const messageCatalog = mockRuMessages as unknown as Record<
          string,
          Record<string, unknown> | undefined
        >;
        const namespaceMessages = messageCatalog[namespace] as
          | Record<string, unknown>
          | undefined;
        const value = namespaceMessages
          ? getValue(namespaceMessages, key)
          : undefined;

        return typeof value === "string" ? value : `${namespace}.${key}`;
      },
  };
});

jest.mock("@/components/dashboard/key-moments-navigator", () => ({
  KeyMomentsNavigator: () => <div>key-moments</div>,
}));

jest.mock("@/components/dashboard/qa-scorecard", () => ({
  QaScorecard: () => <div>qa-scorecard</div>,
}));

jest.mock("./customer-profile-card", () => ({
  CustomerProfileCard: () => <div>customer-profile</div>,
}));

jest.mock("./web-widget-conversation-view", () => ({
  WebWidgetConversationView: () => <div>web-widget-view</div>,
}));

function renderConversationInfo(details: ConversationInfoDetails) {
  return render(
    <ConversationInfo
      details={details}
      conversationId="conv_1"
      messages={[]}
      messageTotal={0}
      onMomentClick={jest.fn()}
    />
  );
}

describe("ConversationInfo", () => {
  it("renders localized labels in the details tabs", () => {
    const details: ConversationInfoDetails = {
      classification: {
        summary: "Клиент ожидает ответ менеджера.",
        action: "Ответить клиенту",
      },
      channel: "whatsapp",
      status: "open",
      airi_bot_enabled: false,
      airi_scenarios_enabled: true,
      airi_coach_enabled: true,
      airi_handoff_active: true,
      airi_handoff_reason: "manager_reply",
      airi_last_suppressed_at: "2026-05-20T09:00:00.000Z",
      airi_last_suppressed_reason: "manager_recently_replied",
      airi_scenario_state: {
        pendingConditionNodeId: "condition_1",
        pendingStartedAt: "2026-05-20T08:00:00.000Z",
        lastMatchedAt: "2026-05-20T08:30:00.000Z",
        startedScenarios: [
          {
            scenarioId: "scenario_1",
            scenarioName: "Follow-up",
            startedAt: "2026-05-20T07:00:00.000Z",
          },
        ],
        completedScenarios: [],
      },
    };

    renderConversationInfo(details);

    expect(screen.getByRole("tab", { name: "Сводка" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Клиент" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Источник" })).toBeInTheDocument();

    expect(screen.getByText("Суть диалога")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Рекомендуемый следующий шаг" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/ConversationDetailView\./)
    ).not.toBeInTheDocument();
  });

  it("keeps the info tabs responsive and renders source timestamps as a timeline", () => {
    const referralBody =
      "This referral body is deliberately long so it must wrap inside the sheet instead of pushing the source tab sideways.";
    const details: ConversationInfoDetails = {
      channel: "whatsapp",
      status: "open",
      createdAt: "2026-05-20T08:00:00.000Z",
      first_inbound_at: "2026-05-20T08:05:00.000Z",
      last_outbound_at: "2026-05-20T08:20:00.000Z",
      lastMessageAt: "2026-05-20T08:25:00.000Z",
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "campaign_1",
        body: referralBody,
        ctwaClid: "A_very_long_click_identifier_that_should_wrap_cleanly",
        capturedAt: "2026-05-20T08:10:00.000Z",
      },
      chat: {
        whatsapp: {
          waId: "77770000000",
          previousWaIds: [],
        },
      },
    };

    renderConversationInfo(details);

    expect(screen.getByRole("tablist")).toHaveClass("!grid", "grid-cols-4");

    fireEvent.mouseDown(screen.getAllByRole("tab")[3]);
    fireEvent.click(screen.getAllByRole("tab")[3]);

    const timeline = screen.getByRole("list", {
      name: getRuConversationMessage("journeyTimelineTitle"),
    });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText(referralBody)).toHaveClass(
      "whitespace-pre-wrap",
      "[overflow-wrap:anywhere]"
    );
    expect(
      screen.queryByText(/ConversationDetailView\./)
    ).not.toBeInTheDocument();
  });

  it("hides duplicated Airi control status tiles in the mobile info sheet", () => {
    const details: ConversationInfoDetails = {
      channel: "whatsapp",
      status: "open",
      airi_bot_enabled: true,
      airi_scenarios_enabled: true,
      airi_coach_enabled: false,
    };

    renderConversationInfo(details);

    const aiTab = screen.getByRole("tab", { name: "AI" });
    fireEvent.mouseDown(aiTab);
    fireEvent.click(aiTab);

    expect(
      screen.queryByTestId("airi-control-status-tiles")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Нет активного сценария")).toBeInTheDocument();
  });

  it("shows one useful empty state without unknown values or empty meters", () => {
    renderConversationInfo({
      classification: { sentiment: "unknown" },
    });
    expect(
      screen.getByText("Сводка появится после анализа переписки.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Неизвестно")).not.toBeInTheDocument();
    expect(screen.queryByText("Нейтральный")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    const source = screen.getByRole("tab", { name: "Источник" });
    fireEvent.mouseDown(source);
    fireEvent.click(source);
    expect(
      screen.getByText("Сведения об источнике не сохранены.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Технические сведения" })
    ).not.toBeInTheDocument();
  });

  it("surfaces open needs and selection without duplicating the summary or exposing raw errors", () => {
    renderConversationInfo({
      classification: {
        summary: "Choose a delivery slot",
        action: "Confirm the address",
      },
      classification_error: "internal-provider-error-secret",
      airi_context_memory: {
        summary: "Choose a delivery slot",
        currentGoal: "Receive tomorrow",
        unresolvedNeeds: ["Address", "Address"],
        activeSelection: { label: "Coffee", quotedPriceText: "14 990 ₸" },
      },
    });
    expect(screen.getAllByText("Choose a delivery slot")).toHaveLength(1);
    expect(screen.getAllByText("Address")).toHaveLength(1);
    expect(screen.getByText("14 990 ₸")).toBeInTheDocument();
    expect(screen.getByText("Receive tomorrow")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Последний анализ недоступен."
    );
    expect(
      screen.queryByText("internal-provider-error-secret")
    ).not.toBeInTheDocument();
  });

  it.each([
    [true, "Согласие получено"],
    [false, "Отказ от согласия"],
    [undefined, "Согласие не зафиксировано"],
  ] as const)(
    "distinguishes consent %s from missing consent",
    (status, label) => {
      renderConversationInfo({
        channel: "whatsapp",
        whatsapp_opt_in: { status },
      });
      const tab = screen.getByRole("tab", { name: "Источник" });
      fireEvent.mouseDown(tab);
      fireEvent.click(tab);
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  );

  it("keeps diagnostic identifiers collapsed and rejects unsafe source links", () => {
    renderConversationInfo({
      sourceId: "source-private-123",
      whatsappReferral: { headline: "Offer", sourceUrl: "javascript:alert(1)" },
    });
    const tab = screen.getByRole("tab", { name: "Источник" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(screen.queryByText("source-private-123")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Технические сведения" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("source-private-123")).toBeVisible();
  });

  it("renders bounded scores with accessible scales and hides invalid scores", () => {
    const { unmount } = renderConversationInfo({
      customer_satisfaction_score: 4,
    });
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(
      screen.getByRole("meter", {
        name: getRuConversationMessage("csatScoreLabel"),
      })
    ).toHaveAttribute("aria-valuemax", "5");
    unmount();
    renderConversationInfo({
      customer_satisfaction_score: 9,
    });
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("names the conversation like the header and reads the scenario from the view model", () => {
    renderConversationInfo({
      channel: "whatsapp",
      rename: "VIP buyer",
      chat: { title: "Customer (wa_77001234567)" },
      customer: { _id: "customer-1", displayName: "Aigerim" },
      airi_scenario_state: { lockedScenarioName: "Lead follow-up" },
    });
    expect(
      screen.getByRole("heading", { name: "VIP buyer" })
    ).toBeInTheDocument();
    expect(screen.getByText("VB")).toBeInTheDocument();
    expect(screen.queryByText(/Customer \(wa_/)).not.toBeInTheDocument();
    const aiTab = screen.getByRole("tab", { name: "AI" });
    fireEvent.mouseDown(aiTab);
    fireEvent.click(aiTab);
    expect(screen.getByText("Lead follow-up")).toBeInTheDocument();
  });

  it("defers the full customer profile until history is expanded and respects identity flags", () => {
    const details = {
      customer: {
        _id: "customer-1",
        displayName: "Aigerim",
        behavioralProfile: { summary: "Prefers short answers" },
      },
    };
    const { unmount } = renderConversationInfo(details);
    const tab = screen.getByRole("tab", { name: "Клиент" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(screen.getByText("Prefers short answers")).toBeVisible();
    expect(screen.queryByText("customer-profile")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "История и связанные профили" })
    );
    expect(screen.getByText("customer-profile")).toBeVisible();
    unmount();
    renderConversationInfo({
      ...details,
      customer_feature_flags: { customer_identity: false },
    });
    expect(screen.queryByText("Aigerim")).not.toBeInTheDocument();
  });
});
