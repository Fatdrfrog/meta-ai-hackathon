/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { SetupWizard } from "./setup-wizard";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouterRefresh = jest.fn();
const mockSaveSetupProfile = jest.fn();
let mockProductMountCount = 0;
let mockProductHandoffListener:
  | ((state: {
      mutationPending: boolean;
      started: boolean;
      ready: boolean;
      background: boolean;
    }) => void)
  | undefined;

jest.mock("@/components/settings/language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));

jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const SelectContext = React.createContext({
    disabled: false,
    onValueChange: (_value: string) => {},
    value: "",
  });

  return {
    Select: ({
      children,
      disabled = false,
      onValueChange = () => {},
      value = "",
    }: {
      children: ReactNode;
      disabled?: boolean;
      onValueChange?: (value: string) => void;
      value?: string;
    }) => (
      <SelectContext.Provider value={{ disabled, onValueChange, value }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: {
      children: ReactNode;
      value: string;
    }) => {
      const context = React.useContext(SelectContext);
      return (
        <button
          type="button"
          aria-pressed={context.value === value}
          disabled={context.disabled}
          onClick={() => context.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
    SelectTrigger: ({
      children,
      ...props
    }: {
      children: ReactNode;
      [key: string]: unknown;
    }) => {
      const context = React.useContext(SelectContext);
      return (
        <button
          type="button"
          role="combobox"
          aria-controls="setup-select-options"
          aria-expanded={false}
          aria-labelledby={props["aria-labelledby"] as string | undefined}
          disabled={context.disabled}
        >
          {children}
        </button>
      );
    },
    SelectValue: ({ placeholder }: { placeholder?: string }) => {
      const context = React.useContext(SelectContext);
      return <span>{context.value || placeholder}</span>;
    },
  };
});
jest.mock("./product-context-step", () => ({
  ProductContextStep: ({
    workspaceId,
    onHandoffStateChange,
  }: {
    workspaceId: string;
    onHandoffStateChange?: typeof mockProductHandoffListener;
  }) => {
    const React = jest.requireActual<typeof import("react")>("react");

    React.useEffect(() => {
      mockProductMountCount += 1;
      mockProductHandoffListener = onHandoffStateChange;
      onHandoffStateChange?.({
        mutationPending: false,
        started: false,
        ready: false,
        background: false,
      });
      return () => {
        mockProductHandoffListener = undefined;
      };
    }, [onHandoffStateChange]);

    return (
      <div data-testid="product-context-step">
        Product step for {workspaceId}
      </div>
    );
  },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    refresh: mockRouterRefresh,
  }),
}));

jest.mock("./actions", () => ({
  saveSetupProfile: (...args: unknown[]) => mockSaveSetupProfile(...args),
}));

jest.mock("next-intl", () => {
  const messages: Record<string, Record<string, string>> = {
    AddCompanyForm: {
      registerCompany: "Register your company",
      lastStepDescription: "Last step",
      stepLabel: "Step {number}",
      requiredBadge: "Required",
      productBadge: "Recommended",
      requiredStepTab: "Company profile",
      productStepTab: "Train Airi",
      requiredStepTitle: "Create your workspace",
      requiredStepDescription: "Add workspace basics.",
      productStepTitle: "Train Airi on your product",
      productStepDescription: "Add your sources so Airi learns your product.",
      continueToProductStep: "Continue to product",
      companyName: "Company name",
      companyNamePlaceholder: "Company",
      phoneNumber: "Phone number (optional)",
      phoneNumberPlaceholder: "+7 701 234 56 78",
      referralSource: "Where did you hear about us? (optional)",
      referralSourcePlaceholder: "Select a source",
      referralSourceGoogle: "Google Search",
      referralSourceLinkedIn: "LinkedIn",
      referralSourceInstagram: "Instagram",
      referralSourceFacebook: "Facebook",
      referralSourceTikTok: "TikTok",
      referralSourceYouTube: "YouTube",
      referralSourceReferral: "Friend or colleague",
      referralSourceEvent: "Event or conference",
      referralSourceProductHunt: "Product Hunt",
      referralSourceOther: "Other",
      referralSourceOtherLabel: "Tell us where",
      referralSourceOtherPlaceholder: "Podcast, community, partner, etc.",
      creating: "Creating",
      registerCompanyButton: "Register company",
      continueToIntegrations: "Continue to integrations",
      requiredStepLockedHint: "Workspace already created.",
      httpError: "HTTP error",
      unknownError: "Unknown error",
      privacyAgreement:
        "I agree to the <privacy>Privacy Policy</privacy> and <terms>Terms</terms>.",
    },
    FinishProfilePage: {
      title: "Profile",
      description: "Profile description",
      fullNameLabel: "Full name",
      fullNamePlaceholder: "Name",
      continueButton: "Continue",
    },
  };

  return {
    useTranslations: (namespace: string) => {
      const translate = (key: string, values?: Record<string, string>) =>
        (messages[namespace]?.[key] || key).replace(
          /\{(\w+)\}/g,
          (_, valueKey: string) => values?.[valueKey] || ""
        );
      translate.rich = (key: string) =>
        translate(key).replace(/<\/?(privacy|terms)>/g, "");
      return translate;
    },
  };
});

const companyResponse = {
  ok: true,
  json: async () => ({
    success: true,
    companyId: "company-1",
    workspaceId: "workspace-1",
  }),
};

function fillCompanyName() {
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "Acme Support" },
  });
}

function acceptPrivacy() {
  fireEvent.click(screen.getByRole("checkbox"));
}

function selectReferralSource(sourceName: string) {
  fireEvent.change(
    screen.getByLabelText("Where did you hear about us? (optional)"),
    { target: { value: sourceName === "Other" ? "other" : sourceName } }
  );
}

function fillRequiredStep() {
  fillCompanyName();
  acceptPrivacy();
}

async function advanceToProductStep() {
  fillRequiredStep();
  fireEvent.click(screen.getByRole("button", { name: "Continue to product" }));
  await screen.findByTestId("product-context-step");
}

describe("SetupWizard", () => {
  it("keeps orchestration separate from the setup view", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "setup-wizard.tsx"),
      "utf8"
    );
    const setupStart = source.indexOf("export function SetupWizard");
    const viewStart = source.indexOf("function SetupWizardView");

    expect(viewStart).toBeGreaterThan(setupStart);
    expect(source.slice(setupStart, viewStart).split("\n").length).toBeLessThan(
      300
    );
  });

  beforeAll(() => {
    installMatchMedia();
    installResizeObserver();
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    window.HTMLElement.prototype.hasPointerCapture = jest.fn(() => false);
    window.HTMLElement.prototype.setPointerCapture = jest.fn();
    window.HTMLElement.prototype.releasePointerCapture = jest.fn();
  });

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterReplace.mockClear();
    mockRouterRefresh.mockClear();
    mockSaveSetupProfile.mockReset();
    mockSaveSetupProfile.mockResolvedValue({ success: true });
    mockProductMountCount = 0;
    mockProductHandoffListener = undefined;
    global.fetch = jest.fn().mockResolvedValue(companyResponse);
  });

  it("uses a linear two-step rail and keeps product training locked until workspace creation", () => {
    const { container } = render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    const shell = container.firstElementChild;
    expect(shell?.className).toEqual(expect.stringContaining("h-dvh"));
    expect(shell?.className).toEqual(
      expect.stringContaining("overflow-y-auto")
    );
    expect(shell?.className).toEqual(
      expect.stringContaining("[scrollbar-gutter:stable]")
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Register your company",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("Company profile")).toBeInTheDocument();
    expect(screen.getByText("Train Airi")).toBeInTheDocument();
    expect(
      screen.getByText("Company profile").closest("button")
    ).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("tab", { name: "Setup preferences" })).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Continue to product",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fillCompanyName();

    expect(
      (
        screen.getByRole("button", {
          name: "Continue to product",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    acceptPrivacy();

    expect(
      (
        screen.getByRole("button", {
          name: "Continue to product",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("creates the workspace on the required step and advances to the product step", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    await advanceToProductStep();

    expect(global.fetch).toHaveBeenCalledWith("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Support",
        accepted_privacy: true,
      }),
    });
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/setup?step=train&workspaceId=workspace-1"
    );
    expect(screen.getByText("Train Airi").closest("button")).toHaveAttribute(
      "aria-current",
      "step"
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          level: 2,
          name: "Train Airi on your product",
        })
      ).toHaveFocus()
    );
  });

  it("submits the optional phone number during workspace setup", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    fillRequiredStep();
    fireEvent.change(screen.getByLabelText("Phone number (optional)"), {
      target: { value: "+7 (701) 234-56-78" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );
    await screen.findByTestId("product-context-step");

    expect(global.fetch).toHaveBeenCalledWith("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Support",
        phone: "+7 (701) 234-56-78",
        accepted_privacy: true,
      }),
    });
  });

  it("submits a known optional referral source during workspace setup", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    fillRequiredStep();
    await selectReferralSource("LinkedIn");
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );
    await screen.findByTestId("product-context-step");

    expect(global.fetch).toHaveBeenCalledWith("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Support",
        signup_referral_source: "LinkedIn",
        accepted_privacy: true,
      }),
    });
  });

  it("submits custom referral text when Other is selected", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    fillRequiredStep();
    await selectReferralSource("Other");
    fireEvent.change(screen.getByLabelText("Tell us where"), {
      target: { value: "  Founder podcast  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );
    await screen.findByTestId("product-context-step");

    expect(global.fetch).toHaveBeenCalledWith("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Support",
        signup_referral_source: "Founder podcast",
        accepted_privacy: true,
      }),
    });
  });

  it("does not render the old optional integration route-selector step", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    await advanceToProductStep();

    expect(screen.queryByText("Personalize onboarding")).toBeNull();
    expect(
      screen.queryByText("Which integration setup should open first?")
    ).toBeNull();
    expect(
      screen.queryByText("What do you want Airi to handle first?")
    ).toBeNull();
  });

  it("keeps an existing workspace incomplete until its required profile is saved", () => {
    render(
      <SetupWizard
        initialFullName="Ada"
        initialWorkspaceId="workspace-1"
        initialStep="product"
        requiresProfile={true}
        requiresWorkspace={false}
      />
    );

    expect(
      screen.getByText("Company profile").closest("[data-complete]")
    ).toHaveAttribute("data-complete", "false");
    expect(screen.getByText("Train Airi").closest("button")).toBeDisabled();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Create your workspace",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("product-context-step")
    ).not.toBeInTheDocument();
  });

  it("blocks the product rail before profile save, then advances through submit", async () => {
    render(
      <SetupWizard
        initialFullName="Ada"
        initialWorkspaceId="workspace-1"
        requiresProfile={true}
        requiresWorkspace={false}
      />
    );

    fireEvent.click(screen.getByText("Train Airi").closest("button")!);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Create your workspace",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("product-context-step")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue to integrations" })
    ).not.toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();

    const fullName = screen.getByLabelText("Full name");
    expect(fullName).toBeEnabled();
    fireEvent.change(fullName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );

    await screen.findByTestId("product-context-step");
    expect(mockSaveSetupProfile).toHaveBeenCalledWith("Ada Lovelace");
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/setup?step=train&workspaceId=workspace-1"
    );
    expect(
      screen.getByText("Company profile").closest("[data-complete]")
    ).toHaveAttribute("data-complete", "true");
  });

  it("does not steal focus when the server initially selects product training", () => {
    render(
      <SetupWizard
        initialFullName="Ada"
        initialWorkspaceId="workspace-1"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Train Airi on your product",
      })
    ).not.toHaveFocus();
  });

  it("hands off once to Integrations with exact background-training analytics", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    await advanceToProductStep();
    act(() => {
      mockProductHandoffListener?.({
        mutationPending: false,
        started: true,
        ready: false,
        background: true,
      });
    });

    expect(
      screen.getAllByRole("button", { name: "Continue to integrations" })
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Start with Airi now" })
    ).not.toBeInTheDocument();

    jest.mocked(global.fetch).mockClear();
    mockRouterReplace.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to integrations" })
    );

    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/onboarding/analytics",
      expect.objectContaining({ method: "POST" })
    );
    const analyticsRequest = jest.mocked(global.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(analyticsRequest?.body))).toEqual({
      event: "onboarding_step_completed",
      step_id: "integrations_handoff",
      metadata: {
        training_started: true,
        training_ready: false,
        training_background: true,
      },
    });
  });

  it("deduplicates a true rapid double-submit of the terminal handoff", () => {
    render(
      <SetupWizard
        initialFullName="Ada"
        initialWorkspaceId="workspace-1"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: false,
        started: true,
        ready: false,
        background: true,
      });
    });
    const continueButton = screen.getByRole("button", {
      name: "Continue to integrations",
    });
    expect(continueButton).toBeEnabled();
    const form = continueButton.closest("form");
    expect(form).not.toBeNull();

    jest.mocked(global.fetch).mockClear();
    mockRouterReplace.mockClear();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
  });

  it("blocks handoff only while the child start mutation is unresolved", async () => {
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    await advanceToProductStep();
    const continueButton = screen.getByRole("button", {
      name: "Continue to integrations",
    });

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: true,
        started: false,
        ready: false,
        background: false,
      });
    });
    expect(continueButton).toBeDisabled();

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: false,
        started: true,
        ready: false,
        background: true,
      });
    });
    expect(continueButton).toBeEnabled();
  });

  it("keeps the product step mounted while a start mutation is unresolved", () => {
    render(
      <SetupWizard
        initialFullName="Ada"
        initialWorkspaceId="workspace-1"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: true,
        started: false,
        ready: false,
        background: false,
      });
    });

    const requiredStep = screen.getByText("Company profile").closest("button");
    expect(requiredStep).toBeDisabled();
    expect(screen.getByText("Train Airi").closest("button")).toBeDisabled();
    fireEvent.click(requiredStep!);
    expect(screen.getByTestId("product-context-step")).toHaveTextContent(
      "workspace-1"
    );
    expect(mockProductHandoffListener).toBeDefined();
    fireEvent.submit(
      screen.getByTestId("product-context-step").closest("form")!
    );
    expect(mockRouterReplace).not.toHaveBeenCalledWith(
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: false,
        started: true,
        ready: false,
        background: true,
      });
    });

    expect(requiredStep).toBeEnabled();
    fireEvent.click(requiredStep!);
    expect(screen.queryByTestId("product-context-step")).toBeNull();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Create your workspace",
      })
    ).toBeInTheDocument();
  });

  it("starts a fresh wizard session when the authorized workspace changes", async () => {
    const { rerender } = render(
      <SetupWizard
        initialFullName="Workspace A owner"
        initialWorkspaceId="workspace-a"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );

    act(() => {
      mockProductHandoffListener?.({
        mutationPending: true,
        started: true,
        ready: false,
        background: false,
      });
    });
    expect(
      screen.getByRole("button", { name: "Continue to integrations" })
    ).toBeDisabled();

    rerender(
      <SetupWizard
        initialFullName="Workspace B owner"
        initialWorkspaceId="workspace-b"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );

    expect(screen.getByTestId("product-context-step")).toHaveTextContent(
      "workspace-b"
    );
    expect(mockProductMountCount).toBe(2);
    expect(screen.queryByText(/workspace-a/i)).toBeNull();
    const continueButton = screen.getByRole("button", {
      name: "Continue to integrations",
    });
    expect(continueButton).toBeEnabled();

    jest.mocked(global.fetch).mockClear();
    mockRouterReplace.mockClear();
    fireEvent.click(continueButton);

    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/panel/w/workspace-b/settings/integrations?new=true&integration=whatsapp"
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-b/onboarding/analytics",
      expect.objectContaining({ method: "POST" })
    );
    const analyticsRequest = jest.mocked(global.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(analyticsRequest?.body))).toEqual({
      event: "onboarding_step_completed",
      step_id: "integrations_handoff",
      metadata: {
        training_started: false,
        training_ready: false,
        training_background: false,
      },
    });
  });

  it("preserves its adopted workspace session across the server resume rerender", async () => {
    const { rerender } = render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    await advanceToProductStep();
    const productHeading = screen.getByRole("heading", {
      level: 2,
      name: "Train Airi on your product",
    });
    await waitFor(() => expect(productHeading).toHaveFocus());
    expect(mockProductMountCount).toBe(1);

    rerender(
      <SetupWizard
        initialFullName=""
        initialWorkspaceId="workspace-1"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Train Airi on your product",
      })
    ).toBe(productHeading);
    expect(productHeading).toHaveFocus();
    expect(mockProductMountCount).toBe(1);
    expect(screen.getByTestId("product-context-step")).toHaveTextContent(
      "workspace-1"
    );

    jest.mocked(global.fetch).mockClear();
    mockRouterReplace.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to integrations" })
    );

    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/onboarding/analytics",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not let an obsolete workspace session replace the newer destination", async () => {
    let resolveProfile!: (result: { success: true }) => void;
    const profilePromise = new Promise<{ success: true }>(resolve => {
      resolveProfile = resolve;
    });
    mockSaveSetupProfile.mockReturnValue(profilePromise);
    const { rerender } = render(
      <SetupWizard
        initialFullName="Workspace A owner"
        initialWorkspaceId="workspace-a"
        requiresProfile={true}
        requiresWorkspace={false}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );
    await waitFor(() => expect(mockSaveSetupProfile).toHaveBeenCalledTimes(1));

    rerender(
      <SetupWizard
        initialFullName="Workspace B owner"
        initialWorkspaceId="workspace-b"
        initialStep="product"
        requiresProfile={false}
        requiresWorkspace={false}
      />
    );
    expect(screen.getByTestId("product-context-step")).toHaveTextContent(
      "workspace-b"
    );

    await act(async () => {
      resolveProfile({ success: true });
      await profilePromise;
      await Promise.resolve();
    });

    expect(mockRouterReplace).not.toHaveBeenCalledWith(
      "/setup?step=train&workspaceId=workspace-a"
    );
    expect(screen.getByTestId("product-context-step")).toHaveTextContent(
      "workspace-b"
    );

    mockRouterReplace.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to integrations" })
    );
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/panel/w/workspace-b/settings/integrations?new=true&integration=whatsapp"
    );
  });

  it("shows localized generic copy instead of a raw company creation 500", async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: "database password is super-secret",
        code: "company_creation_failed",
      }),
    } as Response);
    render(
      <SetupWizard
        initialFullName=""
        requiresProfile={false}
        requiresWorkspace={true}
      />
    );

    fillRequiredStep();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to product" })
    );

    expect(await screen.findByText("Unknown error")).toBeInTheDocument();
    expect(screen.queryByText(/super-secret/i)).toBeNull();
  });
});
