/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PlanUpgradeDialog } from "./plan-upgrade-dialog";

let mockLocale: "en" | "ru" | "kz" = "en";
let mockOnCloseAutoFocus: ((event: Event) => void) | undefined;

// next-intl is ESM-only; translate from the real panel catalogs, which hold
// the PlanUpgradeDialog namespace.

jest.mock("next-intl", () => {
  const { createCatalogNextIntlMock } = jest.requireActual(
    "@/test-support/next-intl-test-utils"
  );
  const catalogs = {
    en: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/panel/en/page.json"),
      "en"
    ),
    ru: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/panel/ru/page.json"),
      "ru"
    ),
    kz: createCatalogNextIntlMock(
      jest.requireActual("../../../messages/panel/kz/page.json"),
      "kz"
    ),
  };
  return {
    useLocale: () => mockLocale,
    useTranslations: (namespace: string) =>
      catalogs[mockLocale].useTranslations(namespace),
  };
});

jest.mock("@/components/ui/dialog", () => {
  const React = jest.requireActual("react") as typeof import("react");

  return {
    Dialog: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open?: boolean;
    }) => (open ? <div>{children}</div> : null),
    DialogContent: ({
      children,
      className,
      onCloseAutoFocus,
    }: {
      children: React.ReactNode;
      className?: string;
      onCloseAutoFocus?: (event: Event) => void;
    }) => {
      mockOnCloseAutoFocus = onCloseAutoFocus;
      return (
        <div role="dialog" className={className}>
          {children}
        </div>
      );
    },
    DialogDescription: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    DialogHeader: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DialogTitle: ({ children }: { children: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
  };
});

jest.mock("@/components/ui/tabs", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const TabsContext = React.createContext<{
    value: string;
    onValueChange: (value: string) => void;
  }>({
    value: "",
    onValueChange: () => undefined,
  });

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange: (value: string) => void;
    }) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({ children, ...props }: { children: React.ReactNode }) => (
      <div role="tablist" {...props}>
        {children}
      </div>
    ),
    TabsTrigger: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const tabs = React.useContext(TabsContext);
      return (
        <button
          role="tab"
          aria-selected={tabs.value === value}
          type="button"
          onClick={() => tabs.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

jest.mock("@/lib/billing/availability", () => ({
  isBillingUiEnabled: () => true,
}));

jest.mock("@/lib/billing/client-checkout", () => ({
  startBillingCheckout: jest.fn(),
}));

describe("PlanUpgradeDialog", () => {
  afterEach(() => {
    mockLocale = "en";
    mockOnCloseAutoFocus = undefined;
  });

  it("returns focus to the control that opened it", () => {
    const { rerender } = render(
      <>
        <button type="button">See plans</button>
        <PlanUpgradeDialog
          workspaceId="workspace-1"
          open={false}
          onOpenChange={jest.fn()}
        />
      </>
    );
    const opener = screen.getByRole("button", { name: "See plans" });
    opener.focus();
    rerender(
      <>
        <button type="button">See plans</button>
        <PlanUpgradeDialog
          workspaceId="workspace-1"
          open
          onOpenChange={jest.fn()}
        />
      </>
    );
    screen.getByRole("dialog").querySelector("button")?.focus();
    const event = new Event("focusOutside", { cancelable: true });
    mockOnCloseAutoFocus?.(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("explains the requested paid feature and its ElevenLabs requirement", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        open
        onOpenChange={jest.fn()}
        reason="feature_limit"
        featureLabel="WhatsApp voice replies"
      />
    );

    expect(
      screen.getByText(
        "Upgrade to unlock WhatsApp voice replies for this workspace."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("WhatsApp voice replies (your ElevenLabs account)")
    ).toBeInTheDocument();
  });

  it("retains the existing explanation when no feature is specified", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        open
        onOpenChange={jest.fn()}
        reason="feature_limit"
      />
    );

    expect(
      screen.getByText("This workspace has reached a plan limit.")
    ).toBeInTheDocument();
  });

  it("shows Pro and Enterprise choices for Free workspaces", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="conversation_limit"
        hiddenCount={12}
      />
    );

    expect(
      screen.getByText(
        "12 conversations are hidden by your current plan. New chats aren't saved until you upgrade."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/New inbound data is still being collected/)
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Enterprise" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upgrade to Pro" })
    ).toBeEnabled();
    expect(screen.getByRole("dialog")).toHaveClass("md:max-w-3xl");
    expect(screen.getByRole("link", { name: "Contact sales" })).toHaveAttribute(
      "href",
      "https://calendar.app.google/iT6L4Vr6L3ma4WY5A"
    );
  });

  it("uses the singular for one hidden conversation", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="conversation_limit"
        hiddenCount={1}
      />
    );

    expect(
      screen.getByText(
        "1 conversation is hidden by your current plan. New chats aren't saved until you upgrade."
      )
    ).toBeInTheDocument();
  });

  it("explains refused new chats at the cap before any conversation is hidden", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="conversation_limit"
        hiddenCount={0}
      />
    );

    expect(
      screen.getByText(
        "This workspace has reached a plan limit. New chats aren't saved until you upgrade."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/conversations are hidden/)
    ).not.toBeInTheDocument();
  });

  it("keeps the trial-expired explanation", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="trial_expired"
      />
    );

    expect(
      screen.getByText(
        "Your 14-day Free trial has ended. Upgrade to reopen this workspace."
      )
    ).toBeInTheDocument();
  });

  it("switches the Pro billing cycle without stating a price", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
      />
    );

    const proCard = screen
      .getByRole("heading", { name: "Pro" })
      .closest("section");
    expect(proCard).not.toBeNull();
    const pro = within(proCard as HTMLElement);

    expect(pro.queryByText("$106")).not.toBeInTheDocument();
    expect(pro.queryByText("$72")).not.toBeInTheDocument();
    expect(pro.queryByText("35% discount")).not.toBeInTheDocument();
    expect(pro.queryByText(/\$\d/)).not.toBeInTheDocument();

    fireEvent.click(pro.getByRole("tab", { name: "Annual" }));

    expect(pro.getByRole("tab", { name: "Annual" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(pro.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it("shows the plan copy in Russian with Russian plurals", () => {
    mockLocale = "ru";
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="conversation_limit"
        hiddenCount={5}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Улучшите тариф" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^5 диалогов скрыто из-за текущего тарифа\./)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Перейти на Pro" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "За год" })).toBeInTheDocument();
    expect(screen.getByText("50 сценариев")).toBeInTheDocument();
    expect(screen.queryByText("Upgrade your plan")).not.toBeInTheDocument();
  });

  it("shows the plan copy in Kazakh", () => {
    mockLocale = "kz";
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="free"
        open
        onOpenChange={jest.fn()}
        reason="trial_expired"
      />
    );

    expect(
      screen.getByRole("heading", { name: "Тарифті жаңартыңыз" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^14 күндік тегін сынақ мерзіміңіз аяқталды\./)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Сату бөлімімен байланысу" })
    ).toBeInTheDocument();
  });

  it("shows only Enterprise for Pro workspaces", () => {
    render(
      <PlanUpgradeDialog
        workspaceId="workspace-1"
        subscriptionType="pro"
        open
        onOpenChange={jest.fn()}
        reason="feature_limit"
      />
    );

    expect(
      screen.queryByRole("heading", { name: "Pro" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Enterprise" })
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("md:max-w-md");
    expect(screen.getByRole("dialog")).not.toHaveClass("md:max-w-3xl");
  });
});
