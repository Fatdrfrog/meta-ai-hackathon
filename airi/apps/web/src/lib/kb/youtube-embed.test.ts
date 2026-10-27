import {
  buildSafeYoutubeIframeHtml,
  getSafeYoutubeEmbedUrl,
  restoreHtmlYoutubeIframes,
  rewriteHtmlYoutubeIframes,
} from "./youtube-embed";

describe("getSafeYoutubeEmbedUrl", () => {
  it("accepts YouTube and youtube-nocookie embed URLs over https", () => {
    expect(
      getSafeYoutubeEmbedUrl(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"
      )
    ).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0");
    expect(
      getSafeYoutubeEmbedUrl("http://youtube.com/embed/dQw4w9WgXcQ")
    ).toBe("https://youtube.com/embed/dQw4w9WgXcQ");
  });

  it("rejects non-embed YouTube URLs and foreign iframes", () => {
    expect(
      getSafeYoutubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBeNull();
    expect(
      getSafeYoutubeEmbedUrl(
        "https://www.youtube.com.evil.com/embed/dQw4w9WgXcQ"
      )
    ).toBeNull();
    expect(getSafeYoutubeEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(
      getSafeYoutubeEmbedUrl("https://evil.example/embed/dQw4w9WgXcQ")
    ).toBeNull();
  });
});

describe("rewriteHtmlYoutubeIframes", () => {
  it("rewrites YouTube iframes and drops other iframe tags", () => {
    const rewritten = rewriteHtmlYoutubeIframes(
      `<div data-youtube-video=""><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" onload="alert(1)"></iframe></div><iframe src="https://evil.example/embed"></iframe>`
    );

    expect(rewritten.html).toContain("%%KB_YOUTUBE_IFRAME_0%%");
    expect(rewritten.html).not.toContain("evil.example");
    expect(rewritten.iframes).toHaveLength(1);
    expect(rewritten.iframes[0]).toBe(
      buildSafeYoutubeIframeHtml(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
      )
    );
    expect(rewritten.iframes[0]).not.toContain("onload");
    expect(
      restoreHtmlYoutubeIframes(rewritten.html, rewritten.iframes)
    ).toContain("kb-editor-youtube-iframe");
  });
});
