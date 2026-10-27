import {
  pickSupportedWidgetLanguage,
  resolveLocalizedWidgetQuickReplies,
} from "@icecore/shared/lib/widget-localization";

describe("widget localization", () => {
  it("defaults to Russian when no supported locale is requested", () => {
    expect(pickSupportedWidgetLanguage([])).toBe("ru");
    expect(pickSupportedWidgetLanguage([undefined, null, []])).toBe("ru");
  });

  it("uses Russian as the default quick reply locale", () => {
    expect(
      resolveLocalizedWidgetQuickReplies({
        defaultQuickReplies: ["Start chat"],
      })
    ).toEqual({
      locale: "ru",
      quickReplies: ["Start chat"],
    });
  });
});
