import { buildWebWidgetInstallSnippets } from "./web-widget-installation-snippets";

describe("buildWebWidgetInstallSnippets", () => {
  const snippets = buildWebWidgetInstallSnippets({
    clientKey: "widget_test",
    widgetUrl: "https://widget.airi.chat",
  });

  it("generates SPA cleanup that clears current and legacy loader state", () => {
    expect(snippets.reactSpaSnippet).toContain(
      "__AIRI_WIDGET_LOADED__ = false"
    );
    expect(snippets.reactSpaSnippet).toContain(
      "__ICECORE_WIDGET_LOADED__ = false"
    );
    expect(snippets.reactSpaSnippet).toContain(
      "window.AiriWidget?.destroy?.()"
    );
  });

  it("uses airi.chat public names in WebView snippets", () => {
    expect(snippets.reactNativeWebViewSnippet).toContain(
      "window.airiWidgetConfig"
    );
    expect(snippets.reactNativeWebViewSnippet).not.toContain(
      "window.iceCoreWidgetConfig"
    );
    expect(snippets.iosAndroidWebViewSnippet).toContain(
      "window.airiWidgetConfig"
    );
    expect(snippets.flutterWebViewSnippet).toContain("window.airiWidgetConfig");
  });

  it("provides a context snippet that works before and after bridge initialization", () => {
    expect(snippets.mobileContextSnippet).toContain("window.airiAppContext");
    expect(snippets.mobileContextSnippet).toContain("window.airiSetContext?.");
    expect(snippets.mobileContextSnippet).not.toContain("icecoreSetContext");
  });
});
