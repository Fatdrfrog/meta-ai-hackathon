import { matchAllowedOption, resolveStableCategory } from "./decision";

describe("classification category decisions", () => {
  it.each([
    [" support ", ["Sales", "Support", "Other"], "Support"],
    ["SALES", ["Sales", "Support"], "Sales"],
    ["unknown", ["Sales", "Support"], null],
    [null, ["Sales", "Support"], null],
  ])(
    "matches %p only to the canonical allowed option",
    (value, options, expected) => {
      expect(matchAllowedOption(value, options)).toBe(expected);
    }
  );

  it.each([
    {
      name: "keeps the existing category when the prediction is unknown",
      predictedCategory: "Unknown",
      predictedConfidence: 1,
      existingCategory: "Support",
      expected: "Support",
    },
    {
      name: "keeps the existing category below the change floor",
      predictedCategory: "Sales",
      predictedConfidence: 0.89,
      existingCategory: "Support",
      expected: "Support",
    },
    {
      name: "changes the existing category at the change floor",
      predictedCategory: "Sales",
      predictedConfidence: 0.9,
      existingCategory: "Support",
      expected: "Sales",
    },
    {
      name: "keeps a matching category below every confidence threshold",
      predictedCategory: "support",
      predictedConfidence: 0.01,
      existingCategory: "Support",
      expected: "Support",
    },
    {
      name: "uses the configured fallback for a low-confidence first category",
      predictedCategory: "Sales",
      predictedConfidence: 0.79,
      existingCategory: null,
      expected: "Other",
    },
  ])("$name", testCase => {
    expect(
      resolveStableCategory({
        predictedCategory: testCase.predictedCategory,
        predictedConfidence: testCase.predictedConfidence,
        confidenceThreshold: 0.8,
        existingCategory: testCase.existingCategory,
        allowedCategories: ["Sales", "Support", "Other"],
        defaultCategory: "Other",
        changeConfidenceFloor: 0.9,
      })
    ).toBe(testCase.expected);
  });
});
