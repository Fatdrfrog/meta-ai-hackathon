/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CustomerProfileCard } from "./customer-profile-card";

let mockLocale: "en" | "ru" | "kz" = "en";

// next-intl is ESM-only; translate from the real conversations catalogs.
jest.mock("next-intl", () => {
  const { createCatalogNextIntlMock } = jest.requireActual(
    "@/test-support/next-intl-test-utils"
  );
  const catalogs = {
    en: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/conversations/en/page.json"),
      "en"
    ),
    ru: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/conversations/ru/page.json"),
      "ru"
    ),
    kz: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/conversations/kz/page.json"),
      "kz"
    ),
  };
  return {
    useLocale: () => mockLocale,
    useTranslations: (namespace: string) =>
      catalogs[mockLocale].useTranslations(namespace),
  };
});

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const originalFetch = global.fetch;

function buildCustomer(fields: Record<string, unknown> = {}) {
  return {
    _id: "customer-1",
    displayName: "Aigerim",
    currentFunnelStage: "lead",
    profileSummary: {
      channels: ["whatsapp", "instagram"],
      languages: ["ru"],
      contactPoints: { phones: ["+77001234567"] },
      conversationCount: 2,
    },
    behavioralProfile: {
      status: "ready",
      summary: "Prefers short answers",
      objections: ["Price"],
      recommendedApproach: ["Send prices first"],
      motivations: ["Speed"],
      communicationStyle: "Direct",
    },
    ...fields,
  };
}

let customer = buildCustomer();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function renderCard(behavioralProfileEnabled = true) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <CustomerProfileCard
        conversationId="conv_1"
        initialCustomer={customer}
        behavioralProfileEnabled={behavioralProfileEnabled}
      />
    </SWRConfig>
  );
}

function openTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

describe("CustomerProfileCard", () => {
  beforeEach(() => {
    mockLocale = "en";
    customer = buildCustomer();
    global.fetch = jest.fn(async (url: string) => {
      if (url === "/api/customers/customer-1") {
        return jsonResponse({
          customer,
          linkedConversations: [
            { _id: "conv_1", rename: "This chat", channel: "whatsapp" },
            { _id: "conv_2", rename: "Instagram chat", channel: "instagram" },
          ],
        });
      }
      if (url === "/api/customers/suggestions?conversationId=conv_1") {
        return jsonResponse({
          suggestions: [
            {
              conversationId: "conv_9",
              displayName: "Aigerim WA",
              channel: "whatsapp",
              score: 88,
              reasons: [
                { code: "phone", label: "Matching normalized phone number" },
                { code: "future_rule", label: "Server-only reason" },
              ],
            },
          ],
        });
      }
      if (url === "/api/customers/link") {
        return jsonResponse({ success: true, customer: { _id: "customer-1" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("adds history without repeating the Customer tab's name, contacts or summary", async () => {
    renderCard();

    expect(await screen.findByText("Instagram chat")).toBeInTheDocument();
    expect(screen.queryByText("This chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeInTheDocument();
    expect(screen.getByText("Speed")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    for (const duplicate of [
      "Aigerim",
      "+77001234567",
      "Prefers short answers",
      "Price",
      "Send prices first",
      "Languages",
    ]) {
      expect(screen.queryByText(duplicate)).not.toBeInTheDocument();
    }
  });

  it("hides the behavioral profile when the workspace turns it off", async () => {
    renderCard(false);

    expect(await screen.findByText("Instagram chat")).toBeInTheDocument();
    expect(screen.queryByText("Behavioral profile")).not.toBeInTheDocument();
    expect(screen.queryByText("Speed")).not.toBeInTheDocument();
  });

  it("links a suggested conversation as a suggested link", async () => {
    renderCard();

    openTab("Suggestions");
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/customers/link",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            sourceConversationId: "conv_1",
            targetConversationId: "conv_9",
            linkMethod: "suggested",
          }),
        })
      );
    });
  });

  it("translates known suggestion reasons and keeps the server label for new ones", async () => {
    mockLocale = "ru";
    renderCard();

    openTab("Подсказки");

    expect(
      await screen.findByText("Тот же номер телефона")
    ).toBeInTheDocument();
    expect(screen.getByText("Server-only reason")).toBeInTheDocument();
    expect(
      screen.queryByText("Matching normalized phone number")
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Оценка 88/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Связать" })).toBeInTheDocument();
  });

  it("renders the overview in Russian with plural-aware relative times", async () => {
    mockLocale = "ru";
    customer = buildCustomer({
      lastInteractionAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    renderCard();

    expect(await screen.findByText("Instagram chat")).toBeInTheDocument();
    expect(screen.getByText("5 минут назад")).toBeInTheDocument();
    expect(screen.getByText("Последнее взаимодействие")).toBeInTheDocument();
    expect(screen.getByText("Связанные диалоги")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отвязать" })
    ).toBeInTheDocument();
    expect(screen.getByText("Поведенческий профиль")).toBeInTheDocument();
    expect(screen.getByText("Стиль общения")).toBeInTheDocument();
    expect(screen.getByText("Мотивация")).toBeInTheDocument();
    expect(screen.getByText("instagram · Неизвестно")).toBeInTheDocument();
  });

  it("writes older Kazakh dates as numbers with the year", async () => {
    mockLocale = "kz";
    customer = buildCustomer({
      lastInteractionAt: new Date(2025, 2, 7, 12, 0).toISOString(),
      behavioralProfile: { status: "insufficient_data" },
    });
    renderCard();

    expect(await screen.findByText("07.03.2025")).toBeInTheDocument();
    expect(screen.getByText("Күйі: Деректер жеткіліксіз")).toBeInTheDocument();
    expect(
      screen.getByText("Бұл клиент үшін мінез-құлық профилі әлі сақталмаған.")
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Хронология" })).toBeInTheDocument();
  });
});
