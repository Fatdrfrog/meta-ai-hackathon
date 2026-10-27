/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type React from "react";
import {
  AiriBuilderIntlProvider,
  AiriPreviewLoadFailure,
} from "./airi-builder-intl-provider";

const mockIntl = {
  locale: "ru",
  missing: [] as string[],
  loadFailures: 0,
};

// A small stand-in for next-intl (ESM-only under Jest): messages flow
// through a context, and a lookup without a message is reported the way
// next-intl reports MISSING_MESSAGE, returning the raw key.
jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const MessagesContext = React.createContext<Record<string, unknown>>({});
  const lookup = (messages: Record<string, unknown>, path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        messages
      );
  return {
    useLocale: () => mockIntl.locale,
    useMessages: () => React.useContext(MessagesContext),
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>;
      children: React.ReactNode;
    }) =>
      React.createElement(
        MessagesContext.Provider,
        { value: messages },
        children
      ),
    useTranslations: (namespace: string) => {
      const messages = React.useContext(MessagesContext);
      return (key: string) => {
        const value = lookup(messages, `${namespace}.${key}`);
        if (typeof value === "string") return value;
        mockIntl.missing.push(`${namespace}.${key}`);
        return `${namespace}.${key}`;
      };
    },
  };
});

jest.mock("@/i18n/airi-builder-client-messages", () => {
  const actual = jest.requireActual<
    typeof import("@/i18n/airi-builder-client-messages")
  >("@/i18n/airi-builder-client-messages");
  return {
    ...actual,
    loadAiriBuilderClientMessages: (
      locale: Parameters<typeof actual.loadAiriBuilderClientMessages>[0]
    ) => {
      if (mockIntl.loadFailures > 0) {
        mockIntl.loadFailures -= 1;
        return Promise.reject(new Error("offline"));
      }
      return actual.loadAiriBuilderClientMessages(locale);
    },
  };
});

function TranslatedBuilder() {
  const scenariosT = useTranslations("Scenarios");
  const templatesT = useTranslations("templates.form");
  return (
    <div data-testid="builder">
      <span>{scenariosT("simulationBack")}</span>
      <span>{templatesT("edit")}</span>
    </div>
  );
}

function renderProvider(parentMessages?: Record<string, unknown>) {
  const tree = (
    <AiriBuilderIntlProvider
      fallback={<div role="status">Loading builder</div>}
    >
      <TranslatedBuilder />
    </AiriBuilderIntlProvider>
  );
  return render(
    parentMessages ? (
      <NextIntlClientProvider
        locale={mockIntl.locale}
        messages={parentMessages}
      >
        {tree}
      </NextIntlClientProvider>
    ) : (
      tree
    )
  );
}

describe("AiriBuilderIntlProvider", () => {
  beforeEach(() => {
    mockIntl.missing = [];
    mockIntl.loadFailures = 0;
  });

  it("offers a retry when the drawer cannot download the builder catalogs", async () => {
    mockIntl.locale = "kz";
    mockIntl.loadFailures = 1;

    renderProvider({ SiteHeader: {} });

    expect(screen.getByRole("status")).toHaveTextContent("Loading builder");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The builder could not load"
    );
    expect(screen.queryByTestId("builder")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("builder")).toBeInTheDocument();
    expect(mockIntl.missing).toEqual([]);
  });

  it("shows a compact preview failure, not the builder's, where a message previews a template", async () => {
    mockIntl.locale = "ru";
    mockIntl.loadFailures = 1;
    const ruChat = jest.requireActual("../../../messages/ru.json").AiriChat;

    render(
      <NextIntlClientProvider
        locale={mockIntl.locale}
        messages={{ AiriChat: ruChat }}
      >
        <AiriBuilderIntlProvider
          fallback={<div role="status">Loading preview</div>}
          renderFailure={retry => <AiriPreviewLoadFailure onRetry={retry} />}
        >
          <TranslatedBuilder />
        </AiriBuilderIntlProvider>
      </NextIntlClientProvider>
    );

    const failure = await screen.findByTestId("airi-preview-load-failure");
    expect(failure).toHaveTextContent(ruChat.previewLoadFailed);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/The builder could not load/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: ruChat.retry }));

    expect(await screen.findByTestId("builder")).toBeInTheDocument();
    expect(mockIntl.missing).toEqual([]);
  });

  it("gives the drawer's builder the Scenarios and templates catalogs of the locale", async () => {
    mockIntl.locale = "ru";

    renderProvider({ SiteHeader: { toggleTheme: "Тема" } });

    const builder = await screen.findByTestId("builder");
    expect(builder).toHaveTextContent("Назад");
    expect(builder).toHaveTextContent("Редактировать шаблон");
    expect(builder).not.toHaveTextContent("Scenarios.");
    expect(builder).not.toHaveTextContent("templates.form.");
    expect(mockIntl.missing).toEqual([]);
  });

  it("renders at once with the catalogs the /airi page already provides", async () => {
    mockIntl.locale = "en";

    renderProvider({
      Scenarios: { simulationBack: "Page back" },
      templates: { form: { edit: "Page edit" } },
    });

    expect(screen.getByTestId("builder")).toHaveTextContent("Page back");
    expect(screen.getByTestId("builder")).toHaveTextContent("Page edit");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
