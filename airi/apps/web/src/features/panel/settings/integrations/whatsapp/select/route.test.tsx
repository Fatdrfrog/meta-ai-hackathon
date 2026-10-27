/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import WhatsAppSelectionPage from "./route";

const push = jest.fn();
const replace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace-1" }),
  usePathname: () =>
    "/panel/w/workspace-1/settings/integrations/whatsapp/select",
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchParams,
}));

jest.mock("@/components/integrations/waba-selection-dialog", () => ({
  WABASelectionPanel: ({
    selectionSession,
    businessId,
    catalogIds,
    embeddedSignupFlow,
    initialSelectedWabaId,
    upgradeIntent,
  }: {
    selectionSession?: boolean;
    businessId?: string | null;
    catalogIds?: string[];
    embeddedSignupFlow?: "cloud_api" | "coexistence" | null;
    initialSelectedWabaId?: string | null;
    upgradeIntent?: boolean;
  }) => (
    <div>
      selection panel {selectionSession ? "session" : "inventory"}{" "}
      {initialSelectedWabaId} {businessId} {catalogIds?.join("|")}{" "}
      {embeddedSignupFlow}
      {upgradeIntent ? " upgrade" : ""}
    </div>
  ),
}));

describe("WhatsAppSelectionPage", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    searchParams = new URLSearchParams(
      "embedded=true&source=embedded_signup&selected_waba_id=waba-1&business_id=business-1&catalog_ids=catalog-1,catalog-2&flow=cloud_api"
    );
  });

  it("renders an Embedded Signup selection backed by the server session", () => {
    render(<WhatsAppSelectionPage />);

    expect(
      screen.getByText(
        /selection panel session waba-1 business-1 catalog-1\|catalog-2 cloud_api/
      )
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("never passes a token from the URL to the selection panel", () => {
    searchParams = new URLSearchParams(
      "token=EAAsecret&embedded=true&source=embedded_signup"
    );

    render(<WhatsAppSelectionPage />);

    expect(screen.getByText(/selection panel session/)).toBeInTheDocument();
    expect(screen.queryByText(/EAAsecret/)).not.toBeInTheDocument();
  });

  it("keeps the upgrade intent for the save without rewriting the URL", () => {
    searchParams.set("intent", "upgrade");

    render(<WhatsAppSelectionPage />);

    expect(screen.getByText(/cloud_api upgrade/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores any other intent", () => {
    searchParams.set("intent", "downgrade");

    render(<WhatsAppSelectionPage />);

    expect(screen.queryByText(/upgrade/)).not.toBeInTheDocument();
  });

  it("allows existing company inventory selection without an embedded signup session", () => {
    searchParams = new URLSearchParams("source=existing");

    render(<WhatsAppSelectionPage />);

    expect(screen.getByText(/selection panel inventory/)).toBeInTheDocument();
    expect(screen.queryByText("sessionExpiredTitle")).not.toBeInTheDocument();
  });

  it("shows the expired state when the page has no selection to resume", () => {
    searchParams = new URLSearchParams("embedded=true");

    render(<WhatsAppSelectionPage />);

    expect(screen.getByText("sessionExpiredTitle")).toBeInTheDocument();
    expect(screen.queryByText(/selection panel/)).not.toBeInTheDocument();
  });
});
