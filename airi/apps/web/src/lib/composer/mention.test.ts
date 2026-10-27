import {
  filterMentionsStillInText,
  getActiveMention,
  mentionTokenFromLabel,
  replaceActiveMention,
} from "./mention";

describe("composer mention helpers", () => {
  it("detects an active @ mention at the caret", () => {
    expect(getActiveMention("hello @im", 9)).toEqual({
      start: 6,
      end: 9,
      query: "im",
    });
    expect(getActiveMention("hello @image ", 13)).toBeNull();
  });

  it("builds and replaces mention tokens", () => {
    expect(mentionTokenFromLabel("Image")).toBe("@Image");
    expect(
      replaceActiveMention({
        value: "make @vi",
        mention: { start: 5, end: 8, query: "vi" },
        token: "@Video",
      })
    ).toEqual({ value: "make @Video ", caret: 12 });
  });

  it("keeps only mentions still present in text", () => {
    expect(
      filterMentionsStillInText({
        value: "hello @Image world",
        items: [{ id: "image" }, { id: "video" }],
        getToken: item => (item.id === "image" ? "@Image" : "@Video"),
      })
    ).toEqual([{ id: "image" }]);
  });
});
