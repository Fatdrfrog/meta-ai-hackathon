const mockContext = jest.fn();
const mockCart = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/website-cart", () => ({
  __esModule: true,
  default: { findById: () => ({ lean: () => mockCart() }) },
}));
jest.mock("@/lib/commerce/cart-journeys", () => ({
  readCartRecoveryToken: () => "1234567890abcdef12345678",
}));
jest.mock("@/lib/commerce/integrations", () => ({
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
import { GET } from "./route";
import { WebsiteCommerceIntegrationError } from "@/lib/commerce/integrations";
const request = () =>
  GET(new Request("https://www.airi.chat/r/cart/token"), {
    params: Promise.resolve({ token: "token" }),
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockCart.mockResolvedValue({
    status: "checkout",
    expiresAt: new Date(Date.now() + 86400000),
    widgetSourceId: "widget",
    recoveryUrl: "https://shop.example/restore/cart",
  });
  mockContext.mockResolvedValue({
    widgetSource: { credentials: { allowed_domains: ["shop.example"] } },
  });
});
test("restores only an active allowlisted cart without exposing its token as a referrer", async () => {
  const response = await request();
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(
    "https://shop.example/restore/cart"
  );
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
});
test("permanently disabled or no-longer-allowlisted links return gone", async () => {
  mockContext.mockRejectedValue(
    new WebsiteCommerceIntegrationError("Disabled", 409, "commerce_disabled")
  );
  expect((await request()).status).toBe(410);
  mockContext.mockResolvedValue({
    widgetSource: { credentials: { allowed_domains: ["another.example"] } },
  });
  expect((await request()).status).toBe(410);
});
test("transient source lookup failure can be retried", async () => {
  mockContext.mockRejectedValue(
    new WebsiteCommerceIntegrationError(
      "Unavailable",
      503,
      "source_lookup_unavailable"
    )
  );
  expect((await request()).status).toBe(503);
});
