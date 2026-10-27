jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: jest.fn() },
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendTokenExpiryAlert } from "./token-expiry-alerts";

describe("connection action alerts", () => {
  const members = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    members.mockResolvedValue({ data: [{ user_id: "manager" }] });
    (supabaseAdmin.from as jest.Mock).mockReturnValue({
      select: () => ({ eq: () => ({ in: members }) }),
    });
  });

  it("describes the WhatsApp customer action without a token countdown", async () => {
    await sendTokenExpiryAlert({
      workspaceId: "workspace",
      integrationType: "whatsapp",
      daysUntilExpiry: 3,
    });
    expect(members).toHaveBeenCalledWith("role", ["admin", "manager"]);
    expect(realtime.trigger).toHaveBeenCalledWith(
      "private-workspace-alerts",
      "alert",
      expect.objectContaining({
        title: "Restore your WhatsApp connection",
        action: {
          label: "Restore connection",
          url: "/panel/w/workspace/settings/integrations?type=whatsapp&reconnect=1",
        },
      })
    );
    const payload = (realtime.trigger as jest.Mock).mock.calls[0][2];
    expect(`${payload.title} ${payload.message}`).not.toMatch(/token|3 days/i);
  });

  it("retains the existing Instagram notification", async () => {
    await sendTokenExpiryAlert({
      workspaceId: "workspace",
      integrationType: "instagram",
      daysUntilExpiry: 3,
    });
    expect(realtime.trigger).toHaveBeenCalledWith(
      "private-workspace-alerts",
      "alert",
      expect.objectContaining({ title: "Instagram Token Expiring Soon" })
    );
  });

  it("does not notify a workspace without admins or managers", async () => {
    members.mockResolvedValue({ data: [] });
    await sendTokenExpiryAlert({
      workspaceId: "workspace",
      integrationType: "whatsapp",
      daysUntilExpiry: 0,
    });
    expect(realtime.trigger).not.toHaveBeenCalled();
  });
});
