import {
  buildWhatsAppMessageCostUsdExpr,
  finalizeCostPerReplyValue,
} from "@/lib/campaign/whatsapp-campaign-cost";
import { WHATSAPP_MESSAGE_RATES_USD } from "@icecore/shared/constants/whatsapp-message-rates";

describe("whatsapp campaign cost helpers", () => {
  it("keeps unknown categories null in the Mongo pricing expression", () => {
    expect(JSON.stringify(buildWhatsAppMessageCostUsdExpr())).toContain(
      '"default":null'
    );
  });
  it("finalizes cost per reply only when replies exist", () => {
    expect(finalizeCostPerReplyValue(1.1, 2)).toBeCloseTo(0.55);
    expect(finalizeCostPerReplyValue(1.1, 0)).toBeNull();
    expect(finalizeCostPerReplyValue(null, 2)).toBeNull();
  });

  it("does not infer tariff coverage from a legacy KZ card", () => {
    const expr = JSON.stringify(buildWhatsAppMessageCostUsdExpr());
    expect(expr).toContain("wasDelivered");
    expect(expr).not.toContain("2026-kz-docs");
    expect(expr).not.toContain(String(WHATSAPP_MESSAGE_RATES_USD.marketing));
    expect(expr).toContain('"default":null');
  });
});
