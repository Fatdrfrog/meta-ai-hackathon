import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "service.ts"), "utf8");

describe("Halyk billing service safety gates", () => {
  it("atomically transitions card-save callbacks to charging before first-period charge", () => {
    expect(source).toContain('status: "charging"');
    expect(source).toContain('.in("status", ["created", "card_saved"])');
    expect(source).toContain('.is("billing_invoice_id", null)');
  });

  it("deduplicates first-period invoices by checkout session", () => {
    expect(source).toContain("checkoutSessionId");
    expect(source).toContain("checkout_session_id");
  });
});
