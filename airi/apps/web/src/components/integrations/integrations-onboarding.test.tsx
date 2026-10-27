/** @jest-environment jsdom */
import { render } from "@testing-library/react";
import { toast } from "sonner";
import { IntegrationsOnboarding } from "./integrations-onboarding";

let mockSearchParams = new URLSearchParams();
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockPush }),
}));
const mockTranslate = (key: string) => key;
jest.mock("next-intl", () => ({ useTranslations: () => mockTranslate }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), info: jest.fn() } }));

describe("integration onboarding notices", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });
  it("does not claim the selected integration succeeded because an unrelated channel exists", () => {
    mockSearchParams = new URLSearchParams("new=true&integration=canva");
    render(<IntegrationsOnboarding connectedIntegrationIds={["telegram"]} />);
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("recognizes configured Calendar and new integration types", () => {
    mockSearchParams = new URLSearchParams("new=true&type=google_calendar");
    render(
      <IntegrationsOnboarding connectedIntegrationIds={["google_calendar"]} />
    );
    expect(toast.success).toHaveBeenCalledWith("integrationSuccessToast");
  });
  it("does not show success on an OAuth error", () => {
    mockSearchParams = new URLSearchParams(
      "new=true&integration=canva&error=oauth_failed"
    );
    render(<IntegrationsOnboarding connectedIntegrationIds={["canva"]} />);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("does not repeat a success notice when source data refreshes", () => {
    mockSearchParams = new URLSearchParams("new=true&integration=canva");
    const { rerender } = render(
      <IntegrationsOnboarding connectedIntegrationIds={["canva"]} />
    );
    rerender(
      <IntegrationsOnboarding connectedIntegrationIds={["canva", "telegram"]} />
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it("asks a new workspace to connect WhatsApp first", () => {
    mockSearchParams = new URLSearchParams("new=true&integration=whatsapp");
    render(
      <IntegrationsOnboarding
        connectedIntegrationIds={[]}
        workspaceId="workspace-1"
      />
    );
    expect(toast.info).toHaveBeenCalledWith("welcomeToast");
  });
  it("offers the template step right after WhatsApp connects", () => {
    // The Embedded Signup success redirect uses type=whatsapp&new=true.
    mockSearchParams = new URLSearchParams(
      "type=whatsapp&new=true&embedded_signup=true"
    );
    render(
      <IntegrationsOnboarding
        connectedIntegrationIds={["whatsapp"]}
        workspaceId="workspace-1"
      />
    );
    expect(toast.success).toHaveBeenCalledWith(
      "whatsappConnectedToast",
      expect.objectContaining({
        action: expect.objectContaining({ label: "createTemplateAction" }),
      })
    );
    const options = jest.mocked(toast.success).mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(mockPush).toHaveBeenCalledWith(
      "/panel/w/workspace-1/messengers/whatsapp-templates?create=1"
    );
  });
});
