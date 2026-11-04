/** @jest-environment node */

const mockFindKit = jest.fn();
const mockWhatsApp = jest.fn();
const mockSendFlow = jest.fn();

jest.mock("@/models/product-kit", () => ({
  ProductKit: {
    findOne: (filter: unknown) => ({ lean: async () => mockFindKit(filter) }),
  },
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockWhatsApp(...args),
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappInteractiveFlow: (...args: unknown[]) => mockSendFlow(...args),
}));

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { sendProductKitFormTest } from "./kit-form-test";

const WS = "workspace-1";
const KIT = "651f1f77bcf86cd799439099";
const TO = "owner-test-phone";

const kit = (orderForm: Record<string, unknown> | null) => ({
  _id: KIT,
  workspaceId: WS,
  language: "kk",
  parts: { orderForm },
});

const send = () =>
  sendProductKitFormTest({ workspaceId: WS, kitId: KIT, to: TO });

const metaRefusal = (code: number) =>
  new MetaGraphRequestError({
    message: "Refused",
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v23.0/phone-1/messages",
    details: { error: { code } },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindKit.mockResolvedValue(
    kit({ state: "ready", flowId: "flow-1", flowName: "Order form" })
  );
  mockWhatsApp.mockResolvedValue({
    context: { accessToken: "token", phoneNumberId: "phone-1" },
  });
  mockSendFlow.mockResolvedValue({ messageId: "wamid.1" });
});

describe("sendProductKitFormTest", () => {
  it("sends the published form to the owner's phone, in the kit's language", async () => {
    expect(await send()).toEqual({ sent: true });

    expect(mockFindKit).toHaveBeenCalledWith({ _id: KIT, workspaceId: WS });
    expect(mockWhatsApp).toHaveBeenCalledWith(WS, {
      requireManager: true,
      requirePhoneNumber: true,
    });
    expect(mockSendFlow).toHaveBeenCalledWith("phone-1", "token", TO, {
      flowId: "flow-1",
      mode: "published",
      flowCta: "Тапсырыс беру",
      bodyText: "Не алғыңыз келеді?",
      flowActionType: "navigate",
      flowActionPayload: { screen: "ORDER" },
    });
  });

  it("uses the edited form's own call to action and first screen", async () => {
    mockFindKit.mockResolvedValue(
      kit({
        state: "ready",
        flowId: "flow-2",
        config: { ctaText: "Заказать", screens: [{ id: "HELLO" }] },
      })
    );
    await send();
    expect(mockSendFlow.mock.calls[0]![3]).toMatchObject({
      flowId: "flow-2",
      flowCta: "Заказать",
      flowActionPayload: { screen: "HELLO" },
    });
  });

  it("sends nothing for a form that is being made, isn't published, or isn't there", async () => {
    mockFindKit.mockResolvedValueOnce(kit({ state: "making" }));
    expect(await send()).toEqual({ refused: "kit_part_busy" });
    for (const orderForm of [
      { state: "draft", flowId: "flow-1" },
      { state: "failed", flowId: null },
      { state: "ready", flowId: null },
      null,
    ]) {
      mockFindKit.mockResolvedValueOnce(kit(orderForm));
      expect(await send()).toEqual({ refused: "invalid_request" });
    }
    expect(mockSendFlow).not.toHaveBeenCalled();
  });

  it("finds no other workspace's kit", async () => {
    mockFindKit.mockResolvedValue(null);
    expect(await send()).toBeNull();
    expect(
      await sendProductKitFormTest({ workspaceId: WS, kitId: "nope", to: TO })
    ).toBeNull();
  });

  it("says when no number is connected, and throws when the connection can't be read", async () => {
    mockWhatsApp.mockResolvedValueOnce({ error: { status: 409 } });
    expect(await send()).toEqual({ refused: "whatsapp_not_connected" });
    mockWhatsApp.mockResolvedValueOnce({
      context: { accessToken: "", phoneNumberId: "phone-1" },
    });
    expect(await send()).toEqual({ refused: "whatsapp_not_connected" });
    mockWhatsApp.mockResolvedValueOnce({ error: { status: 503 } });
    await expect(send()).rejects.toThrow("couldn't be read");
  });

  it("names Meta's refusals of the test phone, and throws the rest", async () => {
    for (const [code, refused] of [
      [131021, "test_phone_is_shop"],
      [131026, "test_phone_unreachable"],
      [131030, "test_phone_not_allowed"],
    ] as const) {
      mockSendFlow.mockRejectedValueOnce(metaRefusal(code));
      expect(await send()).toEqual({ refused });
    }
    mockSendFlow.mockRejectedValueOnce(metaRefusal(131000));
    await expect(send()).rejects.toBeInstanceOf(MetaGraphRequestError);
  });
});
