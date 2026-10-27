export type WebWidgetInstallSnippets = {
  embedCode: string;
  nextJsSnippet: string;
  reactSpaSnippet: string;
  vueNuxtSnippet: string;
  angularSnippet: string;
  reactNativeWebViewSnippet: string;
  iosAndroidWebViewSnippet: string;
  flutterWebViewSnippet: string;
  mobileContextSnippet: string;
};

type BuildWebWidgetInstallSnippetsParams = {
  clientKey: string;
  widgetUrl: string;
};

export function buildWebWidgetInstallSnippets({
  clientKey,
  widgetUrl,
}: BuildWebWidgetInstallSnippetsParams): WebWidgetInstallSnippets {
  const embedCode = `<script async src="${widgetUrl}/loader.js" data-client-key="${clientKey}"></script>`;
  const nextJsSnippet = `import Script from "next/script";

<Script
  src="${widgetUrl}/loader.js"
  data-client-key="${clientKey}"
  strategy="afterInteractive"
/>`;
  const reactSpaSnippet = `import { useEffect } from "react";

useEffect(() => {
  const script = document.createElement("script");
  script.src = "${widgetUrl}/loader.js";
  script.async = true;
  script.setAttribute("data-client-key", "${clientKey}");
  document.body.appendChild(script);

  return () => {
    window.AiriWidget?.destroy?.();
    window.IceCoreWidget?.destroy?.();
    script.remove();
    document.getElementById("airi-widget-host")?.remove();
    window.__AIRI_WIDGET_LOADED__ = false;
    window.__ICECORE_WIDGET_LOADED__ = false;
  };
}, []);`;
  const vueNuxtSnippet = `// Nuxt / Vue
useHead({
  script: [
    {
      src: "${widgetUrl}/loader.js",
      async: true,
      "data-client-key": "${clientKey}",
    },
  ],
});`;
  const angularSnippet = `import { Renderer2 } from "@angular/core";

constructor(private renderer: Renderer2) {}

ngOnInit() {
  const script = this.renderer.createElement("script");
  script.src = "${widgetUrl}/loader.js";
  script.async = true;
  script.setAttribute("data-client-key", "${clientKey}");
  this.renderer.appendChild(document.body, script);
}`;
  const reactNativeWebViewSnippet = `import { WebView } from "react-native-webview";

const injectedJavaScript = \`
  (function () {
    window.airiWidgetConfig = { clientKey: "${clientKey}" };
    var script = document.createElement("script");
    script.src = "${widgetUrl}/loader.js";
    script.async = true;
    document.body.appendChild(script);
  })();
  true;
\`;

<WebView
  source={{ uri: "https://your-domain.com/support" }}
  injectedJavaScript={injectedJavaScript}
/>`;
  const iosAndroidWebViewSnippet = `<!-- In your WebView HTML -->
<script>
  window.airiWidgetConfig = { clientKey: "${clientKey}" };
</script>
<script async src="${widgetUrl}/loader.js"></script>`;
  const flutterWebViewSnippet = `InAppWebView(
  initialUrlRequest: URLRequest(url: WebUri("https://your-domain.com/support")),
  initialUserScripts: UnmodifiableListView([
    UserScript(
      source: """
        window.airiWidgetConfig = { clientKey: "${clientKey}" };
        var script = document.createElement('script');
        script.src = '${widgetUrl}/loader.js';
        script.async = true;
        document.body.appendChild(script);
      """,
      injectionTime: UserScriptInjectionTime.AT_DOCUMENT_END,
    ),
  ]),
);`;
  const mobileContextSnippet = `// Optional: set initial app context before the widget bridge is ready
window.airiAppContext = {
  currentTab: "support",
  screenName: "SupportScreen",
  route: "/app/support",
  metadata: { userId: "123" },
};
window.airiSetContext?.(window.airiAppContext);`;

  return {
    embedCode,
    nextJsSnippet,
    reactSpaSnippet,
    vueNuxtSnippet,
    angularSnippet,
    reactNativeWebViewSnippet,
    iosAndroidWebViewSnippet,
    flutterWebViewSnippet,
    mobileContextSnippet,
  };
}
