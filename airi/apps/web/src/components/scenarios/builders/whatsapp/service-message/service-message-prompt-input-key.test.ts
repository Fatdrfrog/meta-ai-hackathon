import { isScenarioPromptInputKey } from "@icecore/scenario-contracts";
import { suggestPromptInputKey } from "./service-message-prompt-input-key";

const none = new Set<string>();

describe("suggestPromptInputKey", () => {
  it.each([
    ["Customer's name", "customer_s_name"],
    ["Имя клиента", "imya_klienta"],
    ["Жеткізу мекенжайы", "zhetkizu_mekenzhayy"],
    ["  2 Delivery date!  ", "delivery_date"],
    ["Café order", "cafe_order"],
  ])("turns %j into %j", (text, key) => {
    expect(suggestPromptInputKey(text, none)).toBe(key);
    expect(isScenarioPromptInputKey(key)).toBe(true);
  });

  it("returns nothing when no letter is left", () => {
    expect(suggestPromptInputKey("123 !!", none)).toBe("");
    expect(suggestPromptInputKey("", none)).toBe("");
  });

  it("keeps names within 32 characters", () => {
    const key = suggestPromptInputKey(
      "the full delivery address with the entrance and floor",
      none
    );
    expect(key.length).toBeLessThanOrEqual(32);
    expect(isScenarioPromptInputKey(key)).toBe(true);
  });

  it("adds a numbered suffix when the name is taken", () => {
    expect(suggestPromptInputKey("Name", new Set(["name"]))).toBe("name_2");
    expect(suggestPromptInputKey("Name", new Set(["name", "name_2"]))).toBe(
      "name_3"
    );
    const long = "a".repeat(40);
    const suffixed = suggestPromptInputKey(long, new Set(["a".repeat(32)]));
    expect(suffixed).toBe("a".repeat(30) + "_2");
    expect(isScenarioPromptInputKey(suffixed)).toBe(true);
  });
});
