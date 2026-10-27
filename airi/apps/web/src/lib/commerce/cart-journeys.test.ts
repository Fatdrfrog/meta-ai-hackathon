const mockCart = jest.fn();
const mockEvent = jest.fn();
const mockTerminal = jest.fn();
const mockContext = jest.fn();
jest.mock("@/models/website-cart", () => ({
  __esModule: true,
  default: { findOne: () => ({ lean: () => mockCart() }) },
}));
jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: { findOne: () => ({ select: () => ({ lean: () => mockEvent() }) }) },
}));
jest.mock("@/models/website-commerce-event", () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => mockTerminal(...args) },
}));
jest.mock("./integrations", () => ({
  resolveWebsiteCommerceContext: (...args: unknown[]) => mockContext(...args),
  WebsiteCommerceIntegrationError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string
    ) {
      super(message);
    }
  },
}));
import { WebsiteCommerceIntegrationError } from "./integrations";
import {
  createCartRecoveryToken,
  readCartRecoveryToken,
  websiteCartBlockReason,
  websiteCartTemplateValues,
} from "./cart-journeys";
import type { BehaviorRun } from "@/lib/scenarios/behavior-runs";

const cartId = "1234567890abcdef12345678";
const run = {
  referenceId: `website-cart:${cartId}`,
  sourceId: "wa",
  workspaceId: "w",
} as BehaviorRun;
const cart = {
  _id: cartId,
  widgetSourceId: "widget",
  workspaceId: "w",
  cartId: "native-cart",
  checkoutId: "native-checkout",
  status: "checkout",
  version: 3,
  consentAt: new Date(),
  expiresAt: new Date(Date.now() + 86400000),
  recoveryUrl: "https://shop.example/restore/cart",
  currency: "KZT",
  total: 400,
  items: [{ name: "Tea", quantity: 2 }],
};
beforeEach(() => {
  jest.clearAllMocks();
  mockCart.mockResolvedValue(cart);
  mockEvent.mockResolvedValue({
    payload: { behavior: { websiteCartId: cartId, websiteCartVersion: 3 } },
  });
  mockTerminal.mockResolvedValue(null);
  mockContext.mockResolvedValue({
    whatsappSource: { id: "wa" },
    widgetSource: { credentials: { allowed_domains: ["shop.example"] } },
  });
});
test("accepted merchant completion blocks before ledger projection", async () => {
  mockTerminal.mockResolvedValue({ _id: "pending-store-event" });
  expect(await websiteCartBlockReason(run)).toBe("converted");
  expect(mockTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w",
      widgetSourceId: "widget",
      $or: [{ cartId: "native-cart" }, { checkoutId: "native-checkout" }],
    })
  );
});
test.each([
  { status: "paid" },
  { version: 4 },
  { consentAt: undefined },
  { items: [] },
  { expiresAt: new Date(0) },
])("stale or ineligible cart suppresses recovery: %j", async patch => {
  mockCart.mockResolvedValue({ ...cart, ...patch });
  expect(await websiteCartBlockReason(run)).toBe("event_superseded");
});
test("binding changes and missing restore links cannot send recovery", async () => {
  mockContext.mockResolvedValue({ whatsappSource: { id: "other" } });
  expect(await websiteCartBlockReason(run)).toBe("source_or_customer_changed");
  mockContext.mockResolvedValue({ whatsappSource: { id: "wa" } });
  mockCart.mockResolvedValue({ ...cart, recoveryUrl: undefined });
  expect(await websiteCartBlockReason(run)).toBe("cart_recovery_unavailable");
});

test("permanent integration and allowlist changes cancel; transient lookup failures retry", async () => {
  mockContext.mockRejectedValue(
    new WebsiteCommerceIntegrationError("Disabled", 409, "commerce_disabled")
  );
  expect(await websiteCartBlockReason(run)).toBe("source_or_customer_changed");
  mockContext.mockResolvedValue({
    whatsappSource: { id: "wa" },
    widgetSource: { credentials: { allowed_domains: ["new.example"] } },
  });
  expect(await websiteCartBlockReason(run)).toBe("cart_recovery_unavailable");
  mockContext.mockRejectedValue(
    new WebsiteCommerceIntegrationError(
      "Unavailable",
      503,
      "source_lookup_unavailable"
    )
  );
  await expect(websiteCartBlockReason(run)).rejects.toThrow("Unavailable");
});
test("restore tokens are tamper evident, expire, and populate existing template values", async () => {
  const oldSecret = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "test-cart-recovery-key";
  try {
    const now = Date.now();
    const token = createCartRecoveryToken(cartId, now);
    expect(readCartRecoveryToken(token, now)).toBe(cartId);
    expect(
      readCartRecoveryToken(token.replace(cartId, "f".repeat(24)), now)
    ).toBeNull();
    expect(readCartRecoveryToken(token, now + 8 * 86400000)).toBeNull();
    const values = await websiteCartTemplateValues(run);
    expect(values["cart.items"]).toBe("Tea × 2");
    expect(values["cart.total"]).toBe("400.00");
    expect(values["cart.recovery_url"]).toBe(
      `https://www.airi.chat/r/cart/${values["cart.recovery_token"]}`
    );
  } finally {
    if (oldSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = oldSecret;
  }
});
