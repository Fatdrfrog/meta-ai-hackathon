import {
  fetchMetaAdsAdAccountById,
  fetchMetaAdsAdAccountInventory,
  resolveMetaAdsReportingAccounts,
} from "./meta-ads-accounts";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: jest.fn().mockReturnValue({ getJson: jest.fn() }),
}));

const getJson = jest.mocked(getWhatsAppGraphClient().getJson);

describe("Meta Ads account permission-aware fields", () => {
  beforeEach(() => getJson.mockReset());

  it("reports a stored-account cap including a selected account outside the inventory", async () => {
    const onTruncated = jest.fn();
    const accounts = await resolveMetaAdsReportingAccounts({
      accessToken: "token",
      rawCredentials: {
        selected_ad_account_id: "act_selected",
        ad_accounts: [{ id: "act_1" }, { id: "act_2" }],
      },
      maxAccounts: 2,
      onTruncated,
    });
    expect(accounts.map(account => account.id)).toEqual([
      "act_selected",
      "act_1",
    ]);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it("reports a live inventory cap rather than silently presenting a complete account list", async () => {
    const onTruncated = jest.fn();
    getJson.mockResolvedValueOnce({
      data: [{ id: "act_1" }, { id: "act_2" }, { id: "act_3" }],
    });
    await resolveMetaAdsReportingAccounts({
      accessToken: "token",
      rawCredentials: { scope: "ads_read" },
      maxAccounts: 2,
      onTruncated,
    });
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it("passes the report deadline signal to inventory requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Report deadline"));
    await expect(
      resolveMetaAdsReportingAccounts({
        accessToken: "token",
        rawCredentials: {},
        signal: controller.signal,
      })
    ).rejects.toThrow("Report deadline");
    expect(getJson).not.toHaveBeenCalled();
  });

  it("does not fetch another page or fallback account after caller cancellation", async () => {
    const controller = new AbortController();
    getJson.mockImplementationOnce(async () => {
      controller.abort(new Error("Turn deadline"));
      return {
        data: [],
        paging: {
          next: "https://graph.facebook.com/v25.0/me/adaccounts?after=next",
        },
      };
    });
    await expect(
      fetchMetaAdsAdAccountInventory({
        accessToken: "token",
        selectedAdAccountId: "act_old",
        signal: controller.signal,
      })
    ).rejects.toThrow("Turn deadline");
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a failed old-account fallback from a usable new inventory", async () => {
    const onError = jest.fn();
    getJson
      .mockResolvedValueOnce({ data: [{ id: "act_new" }] })
      .mockRejectedValueOnce(new Error("Old account is unavailable"));
    const inventory = await fetchMetaAdsAdAccountInventory({
      accessToken: "token",
      selectedAdAccountId: "act_old",
      grantedScopes: ["ads_read"],
      onError,
    });
    expect(inventory.accounts).toEqual([
      expect.objectContaining({ id: "act_new" }),
    ]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "selected_account" })
    );
  });

  it("discovers reporting accounts without requesting optional Business Manager data", async () => {
    getJson.mockResolvedValueOnce({
      data: [{ id: "act_123", name: "DemoShop" }],
    });
    const inventory = await fetchMetaAdsAdAccountInventory({
      accessToken: "token",
      grantedScopes: ["ads_read"],
    });
    expect(inventory.accounts).toEqual([
      expect.objectContaining({ id: "act_123" }),
    ]);
    expect(getJson.mock.calls[0][1]?.query?.fields).not.toContain("business");
  });

  it("only enriches business metadata when its permission was granted", async () => {
    getJson.mockResolvedValueOnce({ id: "act_123" });
    await fetchMetaAdsAdAccountById({
      accessToken: "token",
      adAccountId: "act_123",
      grantedScopes: ["ads_read", "business_management"],
    });
    expect(getJson.mock.calls[0][1]?.query?.fields).toContain(
      "business{id,name}"
    );
  });

  it("propagates granted permissions to direct lookup beyond the inventory", async () => {
    getJson
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ id: "act_123" });
    const inventory = await fetchMetaAdsAdAccountInventory({
      accessToken: "token",
      selectedAdAccountId: "act_123",
      grantedScopes: ["ads_read"],
    });
    expect(inventory.selectedAccount?.id).toBe("act_123");
    expect(getJson.mock.calls[1][1]?.query?.fields).not.toContain("business");
  });
});
