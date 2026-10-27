import {
  addMessageTextPhrases,
  formatMessageTextPhrases,
  parseMessageTextPhrases,
  removeMessageTextPhrase,
} from "@/components/analytics/bulk-analytics-filter-utils";

describe("bulk analytics message text phrase helpers", () => {
  it("parses comma, semicolon, pipe, and newline separated phrases", () => {
    expect(
      parseMessageTextPhrases("price check, mockup; order|delivery\nthanks")
    ).toEqual(["price check", "mockup", "order", "delivery", "thanks"]);
  });

  it("adds typed phrases without duplicates and keeps phrase text intact", () => {
    expect(
      addMessageTextPhrases(["price check"], "Price check, order")
    ).toEqual(["price check", "order"]);
  });

  it("removes one phrase and formats the API filter string", () => {
    const phrases = removeMessageTextPhrase(
      ["price check", "order", "mockup"],
      "order"
    );

    expect(phrases).toEqual(["price check", "mockup"]);
    expect(formatMessageTextPhrases(phrases)).toBe("price check, mockup");
  });
});
