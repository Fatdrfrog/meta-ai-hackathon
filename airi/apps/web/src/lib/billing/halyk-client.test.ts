import {
  buildHalykTokenFormData,
  getHalykEndpoints,
  isValidHalykInvoiceId,
  normalizeHalykPaymentStatus,
  verifyHalykTransactionStatus,
} from "./halyk-client";

describe("Halyk ePay client helpers", () => {
  const expected = {
    invoiceId: "123456",
    amount: 59000,
    currency: "KZT",
    terminalId: "terminal-1",
  };
  const lookup = {
    resultCode: "100",
    transaction: {
      invoiceID: "123456",
      amount: 59000,
      currency: "KZT",
      terminalID: "terminal-1",
      statusName: "CHARGE",
    },
  };
  it("accepts captured status only for the owned invoice and exact charge", () => {
    expect(verifyHalykTransactionStatus(lookup, expected)).toBe("paid");
    expect(normalizeHalykPaymentStatus(lookup)).toBe("paid");
  });
  it.each([
    { invoiceID: "654321" },
    { amount: 1 },
    { currency: "USD" },
    { terminalID: "another-terminal" },
  ])("rejects mismatched lookup evidence: %p", mismatch => {
    expect(() =>
      verifyHalykTransactionStatus(
        { ...lookup, transaction: { ...lookup.transaction, ...mismatch } },
        expected
      )
    ).toThrow("does not match");
  });
  it.each(["102", "103", "104", "106", "107", "109"])(
    "does not authorize another charge on status lookup error %s",
    resultCode => {
      expect(
        verifyHalykTransactionStatus(
          { resultCode, transaction: null },
          expected
        )
      ).toBe("pending");
    }
  );
  it("does not mistake authorization or incomplete lookup evidence for capture", () => {
    expect(
      verifyHalykTransactionStatus(
        {
          ...lookup,
          transaction: { ...lookup.transaction, statusName: "AUTH" },
        },
        expected
      )
    ).toBe("pending");
    expect(verifyHalykTransactionStatus({ resultCode: "100" }, expected)).toBe(
      "pending"
    );
  });
  it.each(["NEW", "FINGERPRINT", "AUTH", "VERIFIED", ""])(
    "does not treat successful status lookup as a captured payment: %s",
    statusName => {
      expect(
        normalizeHalykPaymentStatus({ resultCode: "100", statusName })
      ).toBe("pending");
    }
  );
  it("recognizes captured and rejected status lookups", () => {
    expect(
      normalizeHalykPaymentStatus({ resultCode: "100", statusName: "CHARGE" })
    ).toBe("paid");
    expect(
      normalizeHalykPaymentStatus({ resultCode: "100", statusName: "FAILED" })
    ).toBe("failed");
  });
  it("builds token form-data for card verification without leaking credentials into the payment object", () => {
    const formData = buildHalykTokenFormData({
      clientId: "client-id",
      clientSecret: "client-secret",
      invoiceId: "123456",
      amount: 0,
      currency: "USD",
      terminalId: "terminal-id",
      postLink: "https://airi.chat/api/billing/halyk/postlink",
      failurePostLink: "https://airi.chat/api/billing/halyk/postlink",
      secretHash: "secret",
      scope: "payment",
    });

    expect(formData.get("grant_type")).toBe("client_credentials");
    expect(formData.get("client_id")).toBe("client-id");
    expect(formData.get("client_secret")).toBe("client-secret");
    expect(formData.get("invoiceID")).toBe("123456");
    expect(formData.get("amount")).toBe("0");
    expect(formData.get("currency")).toBe("USD");
    expect(formData.get("terminal")).toBe("terminal-id");
    expect(formData.get("secret_hash")).toBe("secret");
  });

  it("accepts only numeric 6-15 digit Halyk invoice ids", () => {
    expect(isValidHalykInvoiceId("123456")).toBe(true);
    expect(isValidHalykInvoiceId("123456789012345")).toBe(true);
    expect(isValidHalykInvoiceId("12345")).toBe(false);
    expect(isValidHalykInvoiceId("1234567890123456")).toBe(false);
    expect(isValidHalykInvoiceId("INV-123456")).toBe(false);
  });

  it("normalizes Halyk callback and saved-card statuses", () => {
    expect(normalizeHalykPaymentStatus({ code: "ok" })).toBe("paid");
    expect(normalizeHalykPaymentStatus({ code: 0, status: "AUTH" })).toBe(
      "pending"
    );
    expect(normalizeHalykPaymentStatus({ code: 0, status: "3D" })).toBe(
      "requires_action"
    );
    expect(normalizeHalykPaymentStatus({ resultCode: "102" })).toBe("pending");
    expect(normalizeHalykPaymentStatus({ code: "error" })).toBe("failed");
  });

  it("resolves environment-specific endpoints", () => {
    expect(getHalykEndpoints("test").oauthUrl).toContain("test-epay-oauth");
    expect(getHalykEndpoints("production").cardAuthUrl).toBe(
      "https://epay-api.homebank.kz/payments/cards/auth"
    );
  });
});
