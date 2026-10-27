import {
  htmlToWhatsAppFormat,
  parseWhatsAppTextFormatting,
  textToEditorHtml,
} from "./whatsapp-format";

describe("WhatsApp text formatting", () => {
  it("parses WhatsApp formatting markers without using full Markdown", () => {
    expect(
      parseWhatsAppTextFormatting("Hi *Bold* _Italic_ ~Old~ ```SKU_*_1```")
    ).toEqual([
      { type: "text", text: "Hi " },
      {
        type: "format",
        kind: "bold",
        children: [{ type: "text", text: "Bold" }],
      },
      { type: "text", text: " " },
      {
        type: "format",
        kind: "italic",
        children: [{ type: "text", text: "Italic" }],
      },
      { type: "text", text: " " },
      {
        type: "format",
        kind: "strikethrough",
        children: [{ type: "text", text: "Old" }],
      },
      { type: "text", text: " " },
      { type: "format", kind: "monospace", text: "SKU_*_1" },
    ]);
  });

  it("keeps unsupported Markdown markers literal", () => {
    expect(parseWhatsAppTextFormatting("Use **not bold** here")).toEqual([
      { type: "text", text: "Use **not bold** here" },
    ]);
  });

  it("converts WhatsApp markers into editor HTML for visual editing", () => {
    expect(textToEditorHtml("Hi *Bold* _Italic_ ~Old~")).toBe(
      "<p>Hi <strong>Bold</strong> <em>Italic</em> <s>Old</s></p>"
    );
  });

  it("renders scenario variables as chips and serializes them back to tokens", () => {
    const html = textToEditorHtml("Hey {{first_name}}, welcome");
    expect(html).toContain('data-scenario-variable="first_name"');
    expect(html).toContain("First Name");
    expect(html).not.toContain("{{first_name}}");
    expect(htmlToWhatsAppFormat(html)).toBe("Hey {{first_name}}, welcome");
  });
});
