import {
  PADDLE_BILLING_ENVIRONMENT,
  PADDLE_CHECKOUT_URL,
  getPaddleBillingConfig,
} from "./config";

const originalEnv = process.env;

describe("Paddle billing config", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PADDLE_API_KEY: "pdl_api_key",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_secret",
      PADDLE_PRO_MONTHLY_PRICE_ID: "pri_monthly",
      PADDLE_PRO_ANNUAL_PRICE_ID: "pri_annual",
      PADDLE_ENVIRONMENT: "production",
      PADDLE_CHECKOUT_URL: "https://checkout.example.com/ignored",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses code-owned Paddle environment and checkout URL constants", () => {
    const config = getPaddleBillingConfig();

    expect(config.ok).toBe(true);
    if (!config.ok) {
      throw new Error(`Missing Paddle config: ${config.missing.join(", ")}`);
    }

    expect(config.env).toBe(PADDLE_BILLING_ENVIRONMENT);
    expect(config.checkoutUrl).toBe(PADDLE_CHECKOUT_URL);
  });
});
