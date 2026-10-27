import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { WhatsAppFlowsManager } from "@/components/whatsapp-flows/flows-manager";
import { loadScenariosClientMessages } from "@/i18n/message-loader";
import type { Locale } from "@/i18n/locales";
import WhatsAppFlowsPage from "./whatsapp-flows-route";

let mockLocale: Locale = "ru";
const mockGetContext = jest.fn();
const mockGetReadiness = jest.fn();
const mockRedirect = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq = jest.fn();

jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "NEXT_LOCALE" ? { value: mockLocale } : undefined,
  }),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
}));
jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: () => mockGetContext(),
}));
jest.mock("@/features/panel/shared/workspace/source-readiness", () => ({
  getWorkspaceSourceReadiness: (...args: unknown[]) =>
    mockGetReadiness(...args),
}));
jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: () => null,
}));
jest.mock("@/components/messengers/messengers-layout", () => ({
  MessengersLayout: () => null,
}));
jest.mock("@/components/onboarding/source-required-state", () => ({
  SourceRequiredState: () => null,
}));
jest.mock("@/components/ui/page-header", () => ({ PageHeader: () => null }));
jest.mock("@/components/whatsapp-flows/flows-manager", () => ({
  WhatsAppFlowsManager: () => null,
}));

const workspaceId = "workspace-1";
const sourceRows = [
  {
    id: "wa-1",
    type: "whatsapp",
    name: "Sales",
    credentials: {
      access_token: "server-only-placeholder",
      phone_number_id: "100",
    },
  },
  {
    id: "telegram-1",
    type: "telegram",
    name: "Support",
    credentials: { bot_token: "server-only-placeholder" },
  },
];
const supabase = { from: mockFrom };
const query = { select: mockSelect, eq: mockEq };

function findElement<Props>(
  node: ReactNode,
  type: ReactElement["type"]
): ReactElement<Props> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<Props>;
    const nested = findElement<Props>(child.props.children, type);
    if (nested) return nested;
  }
  return null;
}

function loadPage() {
  return WhatsAppFlowsPage({ params: Promise.resolve({ workspaceId }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLocale = "ru";
  mockGetContext.mockResolvedValue({ supabase, user: { id: "user-1" } });
  mockGetReadiness.mockResolvedValue({ hasWhatsApp: true });
  mockFrom.mockReturnValue(query);
  mockSelect.mockReturnValue(query);
  mockEq.mockImplementation((key: string) =>
    key === "type" ? Promise.resolve({ data: sourceRows }) : query
  );
  mockRedirect.mockImplementation((href: string) => {
    throw new Error(`redirect:${href}`);
  });
});

it.each(["en", "ru", "kz"] as const)(
  "provides the actual route's shared Flow catalog in %s without unrelated feature namespaces",
  async locale => {
    mockLocale = locale;
    const page = await loadPage();
    const provider = findElement<{
      messages: Record<string, unknown>;
      children: ReactNode;
    }>(page, ScopedIntlProvider);
    expect(provider).not.toBeNull();
    if (!provider) throw new Error("Missing manager translation scope");
    const actualCatalog = await loadScenariosClientMessages(locale);
    expect(provider.props.messages).toEqual({
      Scenarios: actualCatalog.Scenarios,
    });
    expect(Object.keys(provider.props.messages)).toEqual(["Scenarios"]);
    expect(
      findElement(provider.props.children, WhatsAppFlowsManager)
    ).not.toBeNull();
    const scenarios = provider.props.messages.Scenarios as Record<
      string,
      unknown
    >;
    // The gallery samples and the editor/template picker/simulator share this
    // namespace, including labels passed to the lazy inline editor.
    for (const key of [
      "flowFieldSampleDate",
      "flowFieldSampleOption",
      "flowFieldSampleAnswer",
      "flowFieldLabelPlaceholder",
      "flowFieldRequired",
      "flowAddField",
      "flowAddOption",
      "flowScreenTitlePlaceholder",
      "flowTemplateAppointmentTitle",
      "flowTemplateAppointmentDesc",
      "simulationInvalidForm",
      "simulationSelectOption",
      "simulationSubmitForm",
      "simulationNextScreen",
    ]) {
      expect(typeof scenarios[key]).toBe("string");
      expect(scenarios[key]).not.toBe(key);
    }
    if (locale === "ru") {
      expect(scenarios.flowFieldSampleDate).toBe("дд.мм.гггг");
      expect(scenarios.flowFieldSampleOption).toBe("Выберите вариант");
      expect(scenarios.flowFieldSampleAnswer).toBe("Введите ответ");
    }
  }
);

it("keeps client source options credential-free inside the translated manager tree", async () => {
  const page = await loadPage();
  const manager = findElement<{
    workspaceId: string;
    sourceOptions: Array<{ id: string; label: string }>;
  }>(page, WhatsAppFlowsManager);
  expect(manager?.props).toEqual({
    workspaceId,
    sourceOptions: [{ id: "wa-1", label: "Sales" }],
  });
  expect(JSON.stringify(page.props)).not.toContain("server-only-placeholder");
  expect(mockFrom).toHaveBeenCalledWith("sources");
  expect(mockEq).toHaveBeenCalledWith("workspace_id", workspaceId);
  expect(mockEq).toHaveBeenCalledWith("type", "whatsapp");
});

it("preserves the no-source connection state without rendering the manager or its catalog", async () => {
  mockGetReadiness.mockResolvedValue({ hasWhatsApp: false });
  const page = await loadPage();
  expect(findElement(page, WhatsAppFlowsManager)).toBeNull();
  expect(findElement(page, ScopedIntlProvider)).toBeNull();
  const state = findElement<{ primaryHref: string }>(page, SourceRequiredState);
  expect(state?.props.primaryHref).toBe(
    `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`
  );
});

it("preserves login redirection before querying workspace sources", async () => {
  mockGetContext.mockResolvedValue({ supabase, user: null });
  await expect(loadPage()).rejects.toThrow("redirect:/login");
  expect(mockRedirect).toHaveBeenCalledWith("/login");
  expect(mockGetReadiness).not.toHaveBeenCalled();
  expect(mockFrom).not.toHaveBeenCalled();
});
