import { extractJsonObject } from "./json-object";

describe("extractJsonObject", () => {
  it("unwraps a JSON object that the model returned as a JSON string", () => {
    expect(
      extractJsonObject(
        '"{\\"category\\":\\"Support\\",\\"confidence\\":{\\"category\\":0.91}}"'
      )
    ).toEqual({
      category: "Support",
      confidence: { category: 0.91 },
    });
  });
});
