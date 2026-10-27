/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TextEncoder } from "node:util";
import type { MetaAdsMcpTransactionV2 } from "@/lib/meta-ads/mcp/confirmation-contract";
import { MetaAdsMcpTransactionReviewDialog } from "./meta-ads-mcp-transaction-review-dialog";
import { MetaAdsMcpReconciliationDialog } from "./meta-ads-mcp-reconciliation-dialog";
import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";
import kz from "../../../messages/kz.json";

// next-intl ships ESM; keep the rendered components and real catalogs while
// replacing only the provider boundary unsupported by this Jest configuration.
jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const Context = React.createContext<Record<string, unknown>>({});
  return {
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>;
      children: React.ReactNode;
    }) => <Context.Provider value={messages}>{children}</Context.Provider>,
    useTranslations: (namespace: string) => {
      const messages = React.useContext(Context);
      return (key: string, values?: Record<string, unknown>) => {
        const value = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (current, part) =>
              current && typeof current === "object"
                ? (current as Record<string, unknown>)[part]
                : undefined,
            messages
          );
        if (typeof value !== "string")
          throw new Error(`Missing translation: ${namespace}.${key}`);
        return value.replace(/\{(\w+)\}/g, (_, name: string) =>
          String(values?.[name] ?? "")
        );
      };
    },
  };
});

const transaction: MetaAdsMcpTransactionV2 = {
  version: 2,
  id: "mutation-1",
  preparedAt: "2026-10-03T00:00:00Z",
  target: {
    sourceId: "source-secret-internal",
    connectionId: "connection-internal",
    mcpUserId: "user-1",
    adAccountId: "act_123",
    adAccountName: "Test account",
    currency: "KZT",
    timezone: "Asia/Qyzylorda",
  },
  tool: {
    name: "ads_update_campaign",
    definitionSha256: "a".repeat(64),
    catalogSha256: "b".repeat(64),
  },
  logicalArguments: { daily_budget: 10000 },
  logicalArgumentsSha256: "c".repeat(64),
  disclosure: {
    operation: "Update campaign",
    accountIds: ["act_123"],
    businessIds: [],
    entities: [
      { type: "campaign", id: "campaign-1", requestedStatus: "PAUSED" },
    ],
    money: [
      {
        path: "daily_budget",
        rawValue: 10000,
        currency: "KZT",
        unit: "provider_raw",
      },
    ],
    schedule: [],
    targeting: [],
    creativeAssets: [],
    unmappedArgumentPaths: [],
    warnings: [],
  },
  summary: "Update the paused test campaign budget",
  transactionDigest: "d".repeat(64),
};

beforeEach(() => {
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
  window.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

it.each([
  {
    locale: "en",
    messages: en,
    confirm: "Confirm and run",
    units: "Units are not verified",
    details: "Technical details",
  },
  {
    locale: "ru",
    messages: ru,
    confirm: "Подтвердить и выполнить",
    units: "Единицы измерения не проверены",
    details: "Технические сведения",
  },
  {
    locale: "kz",
    messages: kz,
    confirm: "Растау және орындау",
    units: "Өлшем бірліктері расталмаған",
    details: "Техникалық мәліметтер",
  },
])(
  "localizes safe money review and hides internal details in $locale",
  async ({ locale, messages, confirm, units, details }) => {
    const onConfirm = jest.fn();
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
      >
        <MetaAdsMcpTransactionReviewDialog
          open
          transaction={transaction}
          state="ready"
          onOpenChange={jest.fn()}
          onConfirm={onConfirm}
        />
      </NextIntlClientProvider>
    );
    expect(screen.getByText(/10000/)).toBeInTheDocument();
    expect(screen.getByText(units, { exact: false })).toBeInTheDocument();
    expect(
      screen.queryByText("source-secret-internal", { exact: false })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("h-[90dvh]");
    const scrollArea = screen
      .getByRole("dialog")
      .querySelector('[data-slot="scroll-area"]');
    expect(scrollArea).toHaveClass(
      "min-h-0",
      "flex-1",
      "[&>[data-slot=scroll-area-viewport]]:absolute",
      "[&>[data-slot=scroll-area-viewport]]:inset-0"
    );
    fireEvent.click(screen.getByRole("button", { name: details }));
    expect(
      screen.getByText("source-secret-internal", { exact: false })
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: confirm }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  }
);

it("records a localized reviewed outcome without invoking a Meta action", async () => {
  const onSubmit = jest.fn();
  render(
    <NextIntlClientProvider locale="ru" messages={ru} timeZone="UTC">
      <MetaAdsMcpReconciliationDialog
        open
        execution={{
          version: 2,
          id: "mutation-1",
          summary: transaction.summary,
          status: "outcome_unknown",
          toolName: "ads_update_campaign",
          claimedAt: "2026-10-03T00:00:00Z",
          transaction,
        }}
        submitting={false}
        onOpenChange={jest.fn()}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>
  );
  expect(screen.getByRole("dialog")).toHaveClass("h-[min(90dvh,42rem)]");
  const scrollArea = screen
    .getByRole("dialog")
    .querySelector('[data-slot="scroll-area"]');
  expect(scrollArea).toHaveClass(
    "min-h-0",
    "flex-1",
    "[&>[data-slot=scroll-area-viewport]]:absolute",
    "[&>[data-slot=scroll-area-viewport]]:inset-0"
  );
  expect(
    screen.getByText(ru.AiriMetaAds.reconciliation.idsHelp)
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Основание для результата"), {
    target: { value: "Проверено в Ads Manager" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Записать результат" }));
  });
  expect(onSubmit).toHaveBeenCalledWith({
    resolution: "succeeded",
    note: "Проверено в Ads Manager",
  });
});

it.each(["stale", "mismatched", "submitting"] as const)(
  "blocks confirmation while review is %s",
  state => {
    const onConfirm = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <MetaAdsMcpTransactionReviewDialog
          open
          transaction={transaction}
          state={state}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      </NextIntlClientProvider>
    );
    const confirm = screen.getByRole("button", {
      name: state === "submitting" ? "Submitting…" : "Confirm and run",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    if (state === "submitting") {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(onOpenChange).not.toHaveBeenCalled();
    }
  }
);

it("keeps reconciliation failures localized with diagnostics behind technical details", () => {
  const providerError = "Provider failed: internal-error-123";
  render(
    <NextIntlClientProvider locale="ru" messages={ru} timeZone="UTC">
      <MetaAdsMcpReconciliationDialog
        open
        execution={{
          version: 2,
          id: "mutation-1",
          summary: transaction.summary,
          status: "outcome_unknown",
          toolName: "ads_update_campaign",
          claimedAt: "2026-10-03T00:00:00Z",
          transaction,
        }}
        submitting={false}
        error={providerError}
        onOpenChange={jest.fn()}
        onSubmit={jest.fn()}
      />
    </NextIntlClientProvider>
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    ru.AiriMetaAds.errors.record
  );
  expect(screen.queryByText(providerError)).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: ru.AiriMetaAds.common.technical })
  );
  expect(screen.getByText(providerError, { exact: false })).toBeInTheDocument();
});
