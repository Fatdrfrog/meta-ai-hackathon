import {
  extractInstagramBranchOptions,
  normalizeInstagramConfig,
} from "@/lib/scenarios/instagram-reply-config";

describe("normalizeInstagramConfig", () => {
  it("normalizes quick replies with stable unique payloads", () => {
    const config = normalizeInstagramConfig({
      kind: "quick_replies",
      quickReplies: [
        { title: "Pricing", payload: "pricing" },
        { title: "Pricing", payload: "pricing" },
        { title: "", payload: "empty" },
      ],
    });

    expect(config).toEqual({
      kind: "quick_replies",
      quickReplies: [
        { title: "Pricing", payload: "pricing" },
        { title: "Pricing", payload: "pricing_2" },
      ],
    });
  });

  it("keeps button templates to three valid Instagram buttons", () => {
    const config = normalizeInstagramConfig({
      kind: "button_template",
      buttons: [
        { type: "postback", title: "Talk", payload: "talk" },
        { type: "web_url", title: "Site", url: "https://example.com" },
        { type: "web_url", title: "Bad", url: "ftp://example.com" },
        { type: "postback", title: "Later", payload: "later" },
      ],
    });

    expect(config.buttons).toEqual([
      { type: "postback", title: "Talk", payload: "talk" },
      { type: "web_url", title: "Site", url: "https://example.com/" },
      { type: "postback", title: "Later", payload: "later" },
    ]);
  });
});

describe("extractInstagramBranchOptions", () => {
  it("extracts card postback branches and drops root buttons a carousel cannot send", () => {
    expect(
      extractInstagramBranchOptions({
        kind: "generic_template",
        quickReplies: [{ title: "Ignored", payload: "ignored" }],
        buttons: [{ type: "postback", title: "Root", payload: "root" }],
        cards: [
          {
            id: "card-1",
            title: "Course",
            buttons: [
              { type: "postback", title: "Enroll", payload: "enroll" },
              {
                type: "web_url",
                title: "Open",
                url: "https://example.com/open",
              },
            ],
          },
        ],
      })
    ).toEqual([{ id: "enroll", label: "Enroll" }]);
  });

  it("keeps root postback buttons as branches for a button template", () => {
    expect(
      extractInstagramBranchOptions({
        kind: "button_template",
        buttons: [{ type: "postback", title: "Root", payload: "root" }],
      })
    ).toEqual([{ id: "root", label: "Root" }]);
  });

  it("does not store root buttons on a generic template", () => {
    expect(
      normalizeInstagramConfig({
        kind: "generic_template",
        buttons: [{ type: "postback", title: "Root", payload: "root" }],
        cards: [{ id: "card-1", title: "Course" }],
      })
    ).toEqual({
      kind: "generic_template",
      cards: [{ id: "card-1", title: "Course" }],
    });
  });
});
