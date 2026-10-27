import type { WhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { getWABAPhoneNumbersStrict } from "./waba-service";

describe("getWABAPhoneNumbersStrict", () => {
  function graphClient(getJson: jest.Mock): WhatsAppGraphClient {
    return { getJson } as unknown as WhatsAppGraphClient;
  }

  it("collects every page and de-duplicates phone records by provider id", async () => {
    const getJson = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "phone-1",
            display_phone_number: "+1 555 0100",
            verified_name: "Primary",
          },
        ],
        paging: {
          next: "https://graph.facebook.com/v25.0/waba-1/phone_numbers?after=cursor-1&access_token=provider-secret",
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "phone-1",
            display_phone_number: "+1 555 0100",
            verified_name: "Duplicate",
          },
          {
            id: "phone-2",
            display_phone_number: "+1 555 0101",
          },
        ],
      });

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
      })
    ).resolves.toEqual([
      {
        id: "phone-1",
        display_phone_number: "+1 555 0100",
        verified_name: "Primary",
      },
      {
        id: "phone-2",
        display_phone_number: "+1 555 0101",
      },
    ]);
    expect(getJson).toHaveBeenNthCalledWith(
      2,
      "https://graph.facebook.com/v25.0/waba-1/phone_numbers?after=cursor-1",
      { token: "access-token" }
    );
  });

  it("forwards page heartbeats and fresh request signals to strict inventory paging", async () => {
    const signal = new AbortController().signal;
    const beforePage = jest.fn().mockResolvedValue(undefined);
    const createRequestSignal = jest.fn(() => signal);
    const getJson = jest.fn().mockResolvedValue({ data: [] });

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
        beforePage,
        createRequestSignal,
      })
    ).resolves.toEqual([]);

    expect(beforePage).toHaveBeenCalledWith({
      pageNumber: 1,
      collectedItems: 0,
    });
    expect(createRequestSignal).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledWith("waba-1/phone_numbers", {
      token: "access-token",
      query: {
        fields:
          "id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,is_on_biz_app,name_status",
        limit: 100,
      },
      signal,
    });
  });

  it("returns an empty inventory only for a valid no-phone response", async () => {
    const getJson = jest.fn().mockResolvedValue({ data: [] });

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
      })
    ).resolves.toEqual([]);
  });

  it("propagates Graph and permission failures", async () => {
    const permissionError = new Error("Missing whatsapp_business_management");
    const getJson = jest.fn().mockRejectedValue(permissionError);

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
      })
    ).rejects.toBe(permissionError);
  });

  it.each([
    null,
    {},
    { data: null },
    { data: [{ id: "phone-1" }] },
    { data: [], paging: "not-an-object" },
    { data: [], paging: { next: 42 } },
  ])("rejects a malformed Graph page %#", async payload => {
    const getJson = jest.fn().mockResolvedValue(payload);

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
      })
    ).rejects.toThrow("Invalid WABA phone numbers response");
  });

  it("rejects repeated paging links instead of looping", async () => {
    const next =
      "https://graph.facebook.com/v25.0/waba-1/phone_numbers?after=repeat";
    const getJson = jest.fn().mockResolvedValue({
      data: [
        {
          id: "phone-1",
          display_phone_number: "+1 555 0100",
        },
      ],
      paging: { next },
    });

    await expect(
      getWABAPhoneNumbersStrict({
        wabaId: "waba-1",
        accessToken: "access-token",
        client: graphClient(getJson),
      })
    ).rejects.toThrow("Meta Graph pagination cycle detected");
    expect(getJson).toHaveBeenCalledTimes(2);
  });
});
