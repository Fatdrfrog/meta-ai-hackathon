/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import type React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TemplatesTable } from "./templates-table";

const originalFetch = global.fetch;
const mockSwitchUnifiedTemplateToCurrentWabaAction = jest.fn();

jest.mock("@/features/panel/messengers/whatsapp-templates/actions", () => ({
  deleteTemplateAction: jest.fn(),
  deleteUnifiedTemplateAction: jest.fn(),
  switchUnifiedTemplateToCurrentWabaAction: (...args: unknown[]) =>
    mockSwitchUnifiedTemplateToCurrentWabaAction(...args),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/components/Masonry", () => ({
  __esModule: true,
  default: ({
    items,
    getKey,
    renderItem,
    className,
  }: {
    items: unknown[];
    getKey: (item: unknown) => string;
    renderItem: (item: unknown) => React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="templates-masonry" className={className}>
      {items.map(item => {
        const key = getKey(item);
        return (
          <div key={key} data-masonry-key={key}>
            {renderItem(item)}
          </div>
        );
      })}
    </div>
  ),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      "alerts.deleteConfirmation":
        "Are you sure you want to delete template {name}? This action cannot be undone.",
      "categories.UTILITY": "Utility",
      create: "Create",
      createFirst: "Create your first template to get started",
      "form.edit": "Edit Template",
      "form.selectTemplateHint":
        "Select a template card to start editing, or create a new one.",
      "form.templateList": "Templates workbench",
      "form.previewEmpty": "Start typing to see a preview.",
      "form.editDisabledMissingDbId":
        "Cannot edit Telegram/unified content: database template ID is missing.",
      "form.editDisabledMissingMetaId":
        "Cannot edit WhatsApp content: Meta template ID is missing.",
      noTemplates: "No templates found",
      "statuses.approved": "Approved",
      "table.duplicate": "Duplicate",
      "table.copyId": "Copy ID",
      "table.delete": "Delete",
      "table.edit": "Edit",
      "table.none": "None",
      "table.preview": "Preview",
      "table.tg": "TG",
      "table.wa": "WA",
      "table.previousWaba": "Previous WABA {id}",
      "table.previousWabaUnknown": "Previous WABA",
      "table.switchToCurrentWaba": "Switch to current WABA",
      "table.switchingToCurrentWaba": "Switching...",
      "alerts.switchToCurrentWabaSuccess":
        "Submitted {name} to the current WhatsApp Business Account.",
      "alerts.switchToCurrentWabaFailed":
        "Failed to switch this template to the current WABA",
      "flowHealth.badge": "Flow issue",
      "flowHealth.screenMissing":
        'The "{button}" button opens screen {screen}, but Flow "{flow}" no longer has it. Customers can\'t open it.',
      "flowHealth.unverified": "Couldn't check this template's Flow.",
      "flowHealth.checkAgain": "Check again",
      "flowHealth.checking": "Checking...",
    };
    return (key: string, values?: Record<string, unknown>) => {
      const template = messages[key] ?? key;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        template
      );
    };
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("./template-form-drawer", () => ({
  TemplateFormDrawer: () => null,
}));

jest.mock("./template-editor-form", () => ({
  TemplateEditorForm: ({
    template,
    title,
  }: {
    template?: { name?: string };
    title?: string;
  }) => (
    <div data-testid="template-editor-form">
      <span>{title}</span>
      <span>{template?.name || "new-template"}</span>
    </div>
  ),
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const { TemplateEditorForm } = jest.requireMock("./template-editor-form") as {
      TemplateEditorForm: (props: {
        template?: { name?: string };
        title?: string;
      }) => React.ReactNode;
    };
    return TemplateEditorForm;
  },
}));

describe("TemplatesTable creation readiness", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bindings: [] }),
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("disables the empty-state create button when template creation is unavailable", async () => {
    render(
      <TemplatesTable
        templates={[]}
        workspaceId="workspace-1"
        onRefresh={jest.fn()}
        canCreateTemplates={false}
        createDisabledReason="Connect WhatsApp before creating templates."
      />
    );

    expect(screen.getByText("No templates found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await act(async () => {});
  });

  it("renders template preview cards in masonry and opens the editor modal on click", async () => {
    render(
      <TemplatesTable
        templates={[
          {
            id: "template-1",
            metaId: "meta-1",
            name: "order_confirmation",
            language: "en_US",
            category: "UTILITY",
            status: "APPROVED",
            channel: "whatsapp",
            components: [
              { type: "BODY", text: "Your order is ready." },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
              },
            ],
          },
        ]}
        workspaceId="workspace-1"
        onRefresh={jest.fn()}
      />
    );

    expect(screen.getByTestId("templates-masonry")).toHaveClass("relative");
    expect(screen.getByTestId("templates-masonry")).not.toHaveClass("grid");
    const card = screen.getByRole("button", {
      name: /order_confirmation/i,
    });
    expect(card).toBeInTheDocument();

    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByTestId("template-editor-form")).toHaveTextContent(
      "order_confirmation"
    );
    // The dialog width stays off the full-width mobile bottom sheet.
    expect(screen.getByRole("dialog")).toHaveClass(
      "md:!w-[min(1180px,calc(100vw-2rem))]"
    );
    expect(screen.getByRole("dialog")).not.toHaveClass(
      "!w-[min(1180px,calc(100vw-2rem))]"
    );
    await act(async () => {});
  });

  it("switches an orphaned template onto the current WABA from the main CTA", async () => {
    mockSwitchUnifiedTemplateToCurrentWabaAction.mockResolvedValue({
      success: true,
      data: {
        metaTemplateId: "meta-new",
        status: "PENDING",
        wabaId: "waba-current",
      },
    });
    const onRefresh = jest.fn();

    render(
      <TemplatesTable
        templates={[
          {
            id: "db-old",
            dbId: "db-old",
            name: "welcome_old",
            language: "en_US",
            category: "UTILITY",
            status: "PENDING",
            channel: "whatsapp",
            sourceWabaId: "waba-previous",
            canSwitchToCurrentWaba: true,
            components: [{ type: "BODY", text: "Welcome" }],
          },
        ]}
        workspaceId="workspace-acme"
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByText("Previous WABA waba-previous")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Switch to current WABA$/i })
    );

    await waitFor(() => {
      expect(mockSwitchUnifiedTemplateToCurrentWabaAction).toHaveBeenCalledWith(
        {
          workspaceId: "workspace-acme",
          templateId: "db-old",
        }
      );
    });
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
    await act(async () => {});
  });

  it("dedupes concurrent OTP binding loads for the same workspace", async () => {
    let resolveFetch: (value: {
      ok: true;
      json: () => Promise<{ bindings: [] }>;
    }) => void = () => undefined;
    const fetchMock = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        })
    );
    global.fetch = fetchMock as typeof fetch;

    render(
      <>
        <TemplatesTable
          templates={[]}
          workspaceId="workspace-1"
          onRefresh={jest.fn()}
        />
        <TemplatesTable
          templates={[]}
          workspaceId="workspace-1"
          onRefresh={jest.fn()}
        />
      </>
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ bindings: [] }),
      });
    });
  });
});

describe("TemplatesTable Flow checks", () => {
  const FLOW_ID = "2244981489363579";
  const CHECKED_AT = "2026-09-28T12:00:00.000Z";
  const medalTemplate = {
    id: "meta-medal",
    metaId: "meta-medal",
    name: "medal_pick_1",
    language: "kk",
    category: "MARKETING" as const,
    status: "APPROVED" as const,
    channel: "whatsapp" as const,
    components: [
      { type: "BODY" as const, text: "Сізге қай спорт түріне арналған?" },
      {
        type: "BUTTONS" as const,
        buttons: [
          {
            type: "FLOW" as const,
            text: "Таңдау",
            flow_id: Number(FLOW_ID),
            flow_action: "NAVIGATE" as unknown as "navigate",
            navigate_screen: "QUESTION_ONE",
          },
        ],
      },
    ],
  };
  const facts = (screenIds: string[] | null, state = "found") =>
    state === "found"
      ? {
          flowId: FLOW_ID,
          state,
          name: "Message templates_medal_pick_1_MARKETING_9b1bc",
          status: "PUBLISHED",
          screenIds,
          checkedAt: CHECKED_AT,
        }
      : { flowId: FLOW_ID, state, checkedAt: CHECKED_AT };

  function mockFetch(healthAnswers: unknown[][]) {
    const answers = [...healthAnswers];
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/flows/template-health")) {
        const next = answers.length > 1 ? answers.shift()! : answers[0];
        return { ok: true, status: 200, json: async () => ({ facts: next }) };
      }
      return { ok: true, status: 200, json: async () => ({ bindings: [] }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const healthCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes("template-health"));

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("warns on a card whose Flow no longer has the button's screen", async () => {
    const fetchMock = mockFetch([[facts(["SURVEY_FORM"])]]);

    render(
      <TemplatesTable
        templates={[medalTemplate]}
        workspaceId="ws-flow-issue"
        onRefresh={jest.fn()}
      />
    );

    expect(await screen.findByText("Flow issue")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      'The "Таңдау" button opens screen QUESTION_ONE, but Flow "Message templates_medal_pick_1_MARKETING_9b1bc" no longer has it.'
    );
    expect(healthCalls(fetchMock)).toEqual([
      expect.stringContaining(`flowIds=${FLOW_ID}`),
    ]);
  });

  it("re-checks one card without opening the editor, then clears the warning", async () => {
    const fetchMock = mockFetch([
      [facts(["SURVEY_FORM"])],
      [facts(["QUESTION_ONE", "DETAILS"])],
    ]);

    render(
      <TemplatesTable
        templates={[medalTemplate]}
        workspaceId="ws-flow-recheck"
        onRefresh={jest.fn()}
      />
    );
    const checkAgain = await screen.findByRole("button", {
      name: /check again/i,
    });

    fireEvent.keyDown(checkAgain, { key: "Enter" });
    fireEvent.click(checkAgain);

    await waitFor(() => {
      expect(screen.queryByText("Flow issue")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(healthCalls(fetchMock)[1]).toContain("refresh=1");
  });

  it("says so quietly when the Flow couldn't be checked", async () => {
    mockFetch([[facts(null, "unavailable")]]);

    render(
      <TemplatesTable
        templates={[medalTemplate]}
        workspaceId="ws-flow-unverified"
        onRefresh={jest.fn()}
      />
    );

    expect(
      await screen.findByText("Couldn't check this template's Flow.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Flow issue")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays silent for a Flow that opens", async () => {
    const fetchMock = mockFetch([[facts(["QUESTION_ONE"])]]);

    render(
      <TemplatesTable
        templates={[medalTemplate]}
        workspaceId="ws-flow-ok"
        onRefresh={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(healthCalls(fetchMock)).toHaveLength(1);
    });
    await act(async () => {});
    expect(
      screen.queryByTestId("template-flow-health-notice")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Flow issue")).not.toBeInTheDocument();
  });

  it("doesn't check templates that still belong to an older WABA", async () => {
    const fetchMock = mockFetch([[facts(["SURVEY_FORM"])]]);

    render(
      <TemplatesTable
        templates={[
          {
            ...medalTemplate,
            dbId: "db-old",
            sourceWabaId: "waba-previous",
            canSwitchToCurrentWaba: true,
          },
        ]}
        workspaceId="ws-flow-previous-waba"
        onRefresh={jest.fn()}
      />
    );

    await act(async () => {});
    expect(healthCalls(fetchMock)).toHaveLength(0);
    expect(screen.queryByText("Flow issue")).not.toBeInTheDocument();
  });
});
