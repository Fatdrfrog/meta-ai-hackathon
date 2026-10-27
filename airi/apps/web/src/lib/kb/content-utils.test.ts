import { convertContentToHtml } from "./content-utils";

describe("convertContentToHtml", () => {
  it("preserves quoted public Supabase image URLs", () => {
    const src =
      "https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/kb-attachments/kb/article/image.png";

    expect(
      convertContentToHtml(
        `<p>Before</p><img class="rounded-md my-6 kb-editor-image" loading="lazy" decoding="async" src="${src}" alt="KB image"><p>After</p>`
      )
    ).toContain(`src="${src}"`);
  });

  it("normalizes safe unquoted image URLs without touching quoted attributes", () => {
    const src =
      "https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/kb-attachments/kb/article/image.png";

    expect(convertContentToHtml(`<img src=${src} alt="KB image">`)).toContain(
      `src="${src}"`
    );
  });

  it("parses markdown links and tables inside content that also contains HTML", () => {
    const html = convertContentToHtml(
      [
        "Intro<br><br>[Meta docs](https://developers.facebook.com/docs/whatsapp/)",
        "",
        "| Provider | Bulk campaigns |",
        "| --- | --- |",
        "| Official | Yes |",
      ].join("\n")
    );

    expect(html).toContain(
      '<a href="https://developers.facebook.com/docs/whatsapp/">Meta docs</a>'
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Provider</th>");
    expect(html).toContain("<td>Official</td>");
  });

  it("keeps published YouTube embeds and strips other iframes", () => {
    const html = convertContentToHtml(
      `<p>Before</p><div data-youtube-video=""><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="960" height="540" allowfullscreen="true"></iframe></div><iframe src="https://evil.example/embed"></iframe><p>After</p>`
    );

    expect(html).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"'
    );
    expect(html).toContain("kb-editor-youtube-iframe");
    expect(html).toContain("data-youtube-video");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("<p>After</p>");
  });
});
