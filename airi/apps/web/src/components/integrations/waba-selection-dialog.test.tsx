/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { getFreePlanUpsellLink } from "@/components/limits/free-plan-upsell";
import { WABASelectionPanel } from "./waba-selection-dialog";

const refresh = jest.fn();
const fetchMock = jest.fn();

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

jest.mock("@/components/limits/free-plan-upsell", () => ({
  getFreePlanUpsellLink: jest.fn(() => "/panel/w/workspace-1/settings/billing"),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages: Record<string, string> = {
      "WABASelection.title": "Select WhatsApp number",
      "WABASelection.description":
        "Choose the phone number that should route messages into this workspace.",
      "WABASelection.searchPlaceholder": "Search WABA, business, or phone",
      "WABASelection.metaBusiness": "Meta Business",
      "WABASelection.accountType.owned": "Owned",
      "WABASelection.accountType.client": "Client",
      "WABASelection.accountTypeLabel": "{type} account",
      "WABASelection.qualityRating": "Quality {rating}",
      "WABASelection.verified": "Verified",
      "WABASelection.connectedHere": "Connected here",
      "WABASelection.connectedElsewhere": "Connected to {workspace}",
      "WABASelection.anotherWorkspace": "another workspace",
      "WABASelection.noPhones": "No phone numbers found for this account",
      "WABASelection.noSearchResults": "No matching numbers",
      "WABASelection.selectionHint": "Select a phone number to continue",
      "WABASelection.selected": "Selected: {phone}",
      "WABASelection.cancel": "Cancel",
      "WABASelection.connect": "Connect number",
      "WABASelection.connecting": "Connecting...",
      "WABASelection.validation.phoneAlreadyConnected":
        "This number is already connected to {workspace}.",
      "WABASelection.fetchFailed": "Failed to fetch WhatsApp accounts",
      "WABASelection.loadFailed": "Failed to load WhatsApp accounts",
      "WABASelection.errorTitle": "Could not load accounts",
      "WABASelection.reauthorizationTitle": "Meta connection required first",
      "WABASelection.reauthorizationDescription":
        "Connect WhatsApp with Meta Embedded Signup before choosing another company number.",
      "WABASelection.reauthorizationAction": "Back to WhatsApp setup",
      "WABASelection.sessionExpiredTitle": "Selection session expired",
      "WABASelection.sessionExpiredDescription":
        "Start Embedded Signup again to refresh the Meta access token and choose a number.",
      "WABASelection.noWabas": "No WhatsApp Business accounts found.",
      "WABASelection.emptyTitle": "No accounts found",
      "WABASelection.createAccount": "Create WhatsApp Business account",
      "WABASelection.saveFailed": "Failed to save WhatsApp connection",
      "WABASelection.completeFailed": "Failed to complete connection",
      "WABASelection.toast.connectFailed": "Failed to connect WhatsApp account",
      "WABASelection.toast.connectSuccess": "WhatsApp number connected.",
      "WABASelection.connectErrors.channelLimitTitle":
        "Your plan can't add this number",
      "WABASelection.connectErrors.channelLimitDescription":
        "Your plan has no room for another WhatsApp number or channel.",
      "WABASelection.connectErrors.trialExpiredDescription":
        "Your trial has ended. Review your plan to connect WhatsApp.",
      "WABASelection.connectErrors.viewPlan": "View plan",
      "WABASelection.connectErrors.flowRebindBlocked":
        "This workspace's WhatsApp number is used by a scenario-managed Flow.",
    };

    return (key: string, values?: Record<string, string>) => {
      const template = messages[`${namespace}.${key}`] ?? key;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template
      );
    };
  },
}));

describe("WABASelectionPanel", () => {
  beforeEach(() => {
    refresh.mockClear();
    jest.mocked(toast.error).mockClear();
    jest.mocked(toast.success).mockClear();
    jest
      .mocked(getFreePlanUpsellLink)
      .mockReturnValue("/panel/w/workspace-1/settings/billing");
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        wabas: [
          {
            waba: {
              id: "waba-1",
              name: "Main WABA",
              account_review_status: "APPROVED",
            },
            phoneNumbers: [
              {
                id: "phone-1",
                display_phone_number: "+7 701 000 00 01",
                verified_name: "Airi Demo",
                code_verification_status: "VERIFIED",
                quality_rating: "GREEN",
              },
            ],
            accountType: "owned",
            businessId: "business-1",
            businessName: "Airi",
          },
          {
            waba: {
              id: "waba-2",
              name: "Retail WABA",
              account_review_status: "APPROVED",
            },
            phoneNumbers: [
              {
                id: "phone-2",
                display_phone_number: "+7 701 000 00 02",
                verified_name: "Retail One",
              },
              {
                id: "phone-3",
                display_phone_number: "+7 701 000 00 03",
                verified_name: "Retail Two",
              },
            ],
            accountType: "client",
            businessId: "business-2",
            businessName: "Retail",
          },
        ],
      }),
    } as Response);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("renders an inline phone picker and preselects the WABA from Meta", async () => {
    render(
      <WABASelectionPanel
        selectionSession
        workspaceId="workspace-1"
        initialSelectedWabaId="waba-2"
        onCancel={jest.fn()}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Select WhatsApp number" })
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search WABA, business, or phone")
    ).toBeInTheDocument();

    await screen.findByText("Retail WABA");

    expect(screen.getByText("+7 701 000 00 02")).toBeInTheDocument();
    expect(screen.getByText("+7 701 000 00 03")).toBeInTheDocument();
    expect(screen.getByText("Client account")).toBeInTheDocument();
    expect(screen.getByText("Selected: +7 701 000 00 02")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("select-waba?"),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("workspace_id=workspace-1")
    );
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("selection_session=1")
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toEqual(
      expect.stringContaining("access_token")
    );
  });

  it("can load company inventory without a fresh embedded signup token", async () => {
    render(
      <WABASelectionPanel workspaceId="workspace-1" onCancel={jest.fn()} />
    );

    await screen.findByText("Main WABA");

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("workspace_id=workspace-1")
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toEqual(
      expect.stringContaining("access_token=")
    );
  });

  it("shows a reconnect CTA when company Meta access is missing", async () => {
    const onCancel = jest.fn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: "reauthorization_required",
        message:
          "Reconnect WhatsApp with Meta before choosing another number for this workspace.",
      }),
    } as Response);

    render(
      <WABASelectionPanel workspaceId="workspace-1" onCancel={onCancel} />
    );

    expect(
      await screen.findByText("Meta connection required first")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect WhatsApp with Meta Embedded Signup before choosing another company number."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Reconnect WhatsApp with Meta before/)
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to WhatsApp setup" })
    );
    expect(onCancel).toHaveBeenCalled();
  });

  it("asks to restart Embedded Signup when the selection session expired", async () => {
    const onCancel = jest.fn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: async () => ({ error: "selection_session_expired" }),
    } as Response);

    render(
      <WABASelectionPanel
        selectionSession
        workspaceId="workspace-1"
        onCancel={onCancel}
      />
    );

    expect(
      await screen.findByText("Selection session expired")
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to WhatsApp setup" })
    );
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows phone ownership conflicts and disables connecting linked phones", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        wabas: [
          {
            waba: {
              id: "waba-1",
              name: "Main WABA",
              account_review_status: "APPROVED",
            },
            phoneNumbers: [
              {
                id: "phone-1",
                display_phone_number: "+7 701 000 00 01",
                verified_name: "Airi Demo",
                ownership: {
                  status: "other_workspace",
                  source_id: "source-2",
                  workspace_id: "workspace-2",
                  workspace_name: "Sales",
                },
              },
            ],
            accountType: "owned",
            businessId: "business-1",
            businessName: "Airi",
          },
        ],
      }),
    } as Response);

    render(
      <WABASelectionPanel
        selectionSession
        workspaceId="workspace-1"
        onCancel={jest.fn()}
      />
    );

    await screen.findByText("Connected to Sales");

    expect(
      screen.getByRole("button", { name: "Connect number" })
    ).toBeDisabled();
    expect(screen.getByRole("radio")).toBeDisabled();
  });

  it.each([
    [true, { intent: "upgrade" }],
    [false, {}],
  ])(
    "sends the upgrade intent with the save only for an upgrade (%s)",
    async (upgradeIntent, expected) => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            wabas: [
              {
                waba: { id: "waba-1", name: "Main WABA" },
                phoneNumbers: [
                  { id: "phone-1", display_phone_number: "+7 701 000 00 01" },
                ],
                accountType: "owned",
                businessId: "business-1",
                businessName: "Airi",
              },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              display_phone_number: "+7 701 000 00 01",
              phone_number_id: "phone-1",
              waba_id: "waba-1",
            },
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        } as Response);

      render(
        <WABASelectionPanel
          selectionSession
          workspaceId="workspace-1"
          embeddedSignupFlow="cloud_api"
          upgradeIntent={upgradeIntent}
          onCancel={jest.fn()}
        />
      );

      await screen.findByText("+7 701 000 00 01");
      fireEvent.click(screen.getByRole("button", { name: "Connect number" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      const saveBody = JSON.parse(
        (fetchMock.mock.calls[2]?.[1] as RequestInit).body as string
      );
      expect(saveBody).toMatchObject(expected);
      if (!upgradeIntent) expect(saveBody).not.toHaveProperty("intent");
    }
  );

  it("persists embedded signup catalog metadata when saving the selected phone", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          wabas: [
            {
              waba: {
                id: "waba-1",
                name: "Main WABA",
                account_review_status: "APPROVED",
              },
              phoneNumbers: [
                {
                  id: "phone-1",
                  display_phone_number: "+7 701 000 00 01",
                  verified_name: "Airi Demo",
                },
              ],
              accountType: "owned",
              businessId: "business-1",
              businessName: "Airi",
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            access_token: "token-1",
            display_phone_number: "+7 701 000 00 01",
            phone_number_id: "phone-1",
            waba_id: "waba-1",
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

    render(
      <WABASelectionPanel
        selectionSession
        workspaceId="workspace-1"
        businessId="business-1"
        catalogIds={["catalog-1", "catalog-2"]}
        embeddedSignupEvent="FINISH"
        embeddedSignupFlow="cloud_api"
        onCancel={jest.fn()}
      />
    );

    await screen.findByText("+7 701 000 00 01");
    fireEvent.click(screen.getByRole("button", { name: "Connect number" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/sources/whatsapp",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        })
      );
    });

    const saveBody = JSON.parse(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body as string
    );
    expect(saveBody).not.toHaveProperty("access_token");
    expect(
      JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)
    ).not.toHaveProperty("access_token");
    expect(saveBody).toMatchObject({
      business_id: "business-1",
      catalog_ids: ["catalog-1", "catalog-2"],
      embedded_signup: true,
      embedded_signup_event: "FINISH",
      embedded_signup_flow: "cloud_api",
    });
  });

  describe("connection failures", () => {
    const oneNumber = {
      ok: true,
      json: async () => ({
        wabas: [
          {
            waba: { id: "waba-1", name: "Main WABA" },
            phoneNumbers: [
              { id: "phone-1", display_phone_number: "+7 701 000 00 01" },
            ],
            accountType: "owned",
            businessId: "business-1",
            businessName: "Airi",
          },
        ],
      }),
    } as Response;
    const selectionOk = {
      ok: true,
      json: async () => ({
        data: {
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          display_phone_number: "+7 701 000 00 01",
        },
      }),
    } as Response;
    const failed = (status: number, body: unknown) =>
      ({ ok: false, status, json: async () => body }) as Response;

    async function connectWith(...responses: Array<Response | Error>) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(oneNumber);
      for (const response of responses) {
        if (response instanceof Error)
          fetchMock.mockRejectedValueOnce(response);
        else fetchMock.mockResolvedValueOnce(response);
      }
      const onSuccess = jest.fn();
      const onCancel = jest.fn();
      render(
        <WABASelectionPanel
          selectionSession
          workspaceId="workspace-1"
          onCancel={onCancel}
          onSuccess={onSuccess}
        />
      );
      await screen.findByText("+7 701 000 00 01");
      fireEvent.click(screen.getByRole("button", { name: "Connect number" }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledTimes(1 + responses.length)
      );
      return { onSuccess, onCancel };
    }

    it.each([
      "Reconnect WhatsApp with Meta before choosing another number for this workspace.",
      "Meta removed airi.chat's access to this WhatsApp account. Reconnect it with Meta before choosing a number.",
    ])(
      "asks for a Meta reconnect when saving is refused: %s",
      async message => {
        const { onSuccess, onCancel } = await connectWith(
          selectionOk,
          failed(409, { error: "reauthorization_required", message })
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Meta connection required first");
        expect(alert).toHaveTextContent(
          "Connect WhatsApp with Meta Embedded Signup before choosing another company number."
        );
        expect(alert).not.toHaveTextContent(message);
        expect(alert).toHaveFocus();
        expect(
          screen.getByRole("button", { name: "Connect number" })
        ).toBeDisabled();
        fireEvent.click(
          screen.getByRole("button", { name: "Back to WhatsApp setup" })
        );
        expect(onCancel).toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
      }
    );

    it("marks the number as connected elsewhere when another workspace owns it", async () => {
      await connectWith(
        selectionOk,
        failed(409, {
          error: "phone_already_connected",
          message: "This WhatsApp number is already connected to Sales.",
          conflict: {
            phone_number_id: "phone-1",
            source_id: "source-2",
            workspace_id: "workspace-2",
            workspace_name: "Sales",
          },
        })
      );

      await screen.findByText("Connected to Sales");
      expect(toast.error).toHaveBeenCalledWith(
        "This number is already connected to Sales."
      );
      expect(screen.getByRole("radio")).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Connect number" })
      ).toBeDisabled();
    });

    it.each([
      [false, "Your plan has no room for another WhatsApp number or channel."],
      [true, "Your trial has ended. Review your plan to connect WhatsApp."],
    ])(
      "explains a plan limit instead of the server sentence (trial expired: %s)",
      async (trialExpired, description) => {
        await connectWith(
          selectionOk,
          failed(402, {
            code: "company_channel_limit_exceeded",
            error:
              "Company channel limit exceeded. Upgrade to Pro to connect more channels.",
            limit: { trialExpired },
          })
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Your plan can't add this number");
        expect(alert).toHaveTextContent(description);
        expect(alert).not.toHaveTextContent(/Upgrade to Pro/);
        const viewPlan = screen.getByRole("link", { name: "View plan" });
        expect(viewPlan).toHaveAttribute(
          "href",
          "/panel/w/workspace-1/settings/billing"
        );
        // Same-tab navigation would drop the Embedded Signup token.
        expect(viewPlan).toHaveAttribute("target", "_blank");
      }
    );

    it("keeps the list and lets the user retry after a plan limit", async () => {
      const { onSuccess } = await connectWith(
        selectionOk,
        failed(402, { code: "company_channel_limit_exceeded" })
      );

      expect(await screen.findByRole("alert")).toHaveFocus();
      expect(screen.getByText("+7 701 000 00 01")).toBeInTheDocument();
      const connect = screen.getByRole("button", { name: "Connect number" });
      await waitFor(() => expect(connect).toBeEnabled());

      fetchMock.mockResolvedValueOnce(selectionOk).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
      fireEvent.click(connect);

      await waitFor(() => expect(onSuccess).toHaveBeenCalled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("omits the plan link when billing is not available", async () => {
      jest.mocked(getFreePlanUpsellLink).mockReturnValue(null);
      await connectWith(
        selectionOk,
        failed(402, { code: "company_channel_limit_exceeded" })
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your plan can't add this number"
      );
      expect(
        screen.queryByRole("link", { name: "View plan" })
      ).not.toBeInTheDocument();
    });

    it("explains a blocked Flow rebind and keeps the list usable", async () => {
      await connectWith(
        selectionOk,
        failed(409, {
          error: "WHATSAPP_FLOW_SOURCE_REBIND_BLOCKED",
          message: "This source is bound to a managed Flow.",
        })
      );

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "This workspace's WhatsApp number is used by a scenario-managed Flow."
        )
      );
      expect(
        screen.getByRole("button", { name: "Connect number" })
      ).toBeEnabled();
    });

    it.each([
      failed(400, { error: "Token is not valid for the configured Meta app" }),
      failed(401, { error: "Unauthorized" }),
      failed(500, { error: "new row violates row-level security policy" }),
      {
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as unknown as Response,
    ])(
      "shows a localized message for an unexpected save failure",
      async response => {
        await connectWith(selectionOk, response);

        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "Failed to save WhatsApp connection"
          )
        );
        expect(toast.error).toHaveBeenCalledTimes(1);
      }
    );

    it("shows a localized message when the save request cannot be sent", async () => {
      await connectWith(selectionOk, new TypeError("Failed to fetch"));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Failed to complete connection"
        )
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Connect number" })
        ).toBeEnabled()
      );
    });

    it("stops before saving when the number selection is refused", async () => {
      await connectWith(
        failed(409, {
          error: "reauthorization_required",
          message:
            "Reconnect WhatsApp with Meta before choosing another number.",
        })
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Meta connection required first"
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/sources/whatsapp",
        expect.anything()
      );
    });

    it("confirms a successful connection", async () => {
      const { onSuccess } = await connectWith(selectionOk, {
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      await waitFor(() => expect(onSuccess).toHaveBeenCalled());
      expect(toast.success).toHaveBeenCalledWith("WhatsApp number connected.");
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("shows a localized error when the account list cannot load", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "selection_failed", message: "boom" }),
    } as Response);

    render(
      <WABASelectionPanel workspaceId="workspace-1" onCancel={jest.fn()} />
    );

    expect(
      await screen.findByText("Failed to fetch WhatsApp accounts")
    ).toBeInTheDocument();
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });
});
