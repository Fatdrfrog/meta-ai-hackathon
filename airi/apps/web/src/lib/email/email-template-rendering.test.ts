import { renderMarkdownEmailTemplate } from "./email-template-rendering";

describe("renderMarkdownEmailTemplate", () => {
  it("renders markdown email with variables and safe html", () => {
    const rendered = renderMarkdownEmailTemplate({
      subject: "Welcome, {{ userName }}",
      markdown:
        "# Hi {{userName}}\n\nYour **{{workspaceName}}** workspace is ready.\n\n- Connect email\n- Invite team\n\n[Continue setup]({{setupUrl}})\n\n<script>alert(1)</script>",
      variables: {
        userName: "Founder <Admin>",
        workspaceName: "Acme Support",
        setupUrl: "https://app.airi.chat/panel/w/workspace-1/email",
      },
    });

    expect(rendered.subject).toBe("Welcome, Founder <Admin>");
    expect(rendered.text).toContain("Your Acme Support workspace is ready.");
    expect(rendered.html).toContain("Founder &lt;Admin&gt;");
    expect(rendered.html).toContain("<strong>Acme Support</strong>");
    expect(rendered.html).toContain("<ul");
    expect(rendered.html).toContain(
      'href="https://app.airi.chat/panel/w/workspace-1/email"'
    );
    expect(rendered.html).not.toContain("<script>");
  });

  it("renders email-safe uploaded images and strips unsafe image urls", () => {
    const rendered = renderMarkdownEmailTemplate({
      subject: "Launch update",
      markdown:
        "![Hero <shot>](https://cdn.airi.chat/email-campaign-assets/hero.png)\n\n![Bad](javascript:alert(1))",
      variables: {},
    });

    expect(rendered.html).toContain(
      'src="https://cdn.airi.chat/email-campaign-assets/hero.png"'
    );
    expect(rendered.html).toContain('alt="Hero &lt;shot&gt;"');
    expect(rendered.html).toContain('src="#"');
    expect(rendered.html).not.toContain("javascript:alert");
    expect(rendered.text).toContain(
      "Hero <shot> (https://cdn.airi.chat/email-campaign-assets/hero.png)"
    );
  });

  it("renders adjacent inline links", () => {
    const rendered = renderMarkdownEmailTemplate({
      subject: "Links",
      markdown: "[One](https://a.example)[Two](https://b.example)",
      variables: {},
    });

    expect(rendered.html).toContain('href="https://a.example"');
    expect(rendered.html).toContain('href="https://b.example"');
    expect(rendered.html).not.toContain("[Two](");
  });

  it("escapes link and image query strings once in html and not at all in text", () => {
    const rendered = renderMarkdownEmailTemplate({
      subject: "Links",
      markdown:
        "[Continue setup]({{setupUrl}})\n\n![Hero](https://cdn.example/hero.png?w=600&h=300)",
      variables: {
        setupUrl:
          "https://app.airi.chat/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp",
      },
    });

    expect(rendered.html).toContain(
      'href="https://app.airi.chat/panel/w/workspace-1/settings/integrations?new=true&amp;integration=whatsapp"'
    );
    expect(rendered.html).toContain(
      'src="https://cdn.example/hero.png?w=600&amp;h=300"'
    );
    expect(rendered.html).not.toContain("&amp;amp;");
    expect(rendered.text).toContain(
      "Continue setup (https://app.airi.chat/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp)"
    );
    expect(rendered.text).toContain(
      "Hero (https://cdn.example/hero.png?w=600&h=300)"
    );
  });

  it("keeps quotes in link urls from breaking out of the href attribute", () => {
    const rendered = renderMarkdownEmailTemplate({
      subject: "Links",
      markdown: '[Open](https://a.example/" onclick="alert(1))',
      variables: {},
    });

    expect(rendered.html).toContain(
      'href="https://a.example/&quot; onclick=&quot;alert(1"'
    );
    expect(rendered.html).not.toContain('" onclick="');
  });
});
