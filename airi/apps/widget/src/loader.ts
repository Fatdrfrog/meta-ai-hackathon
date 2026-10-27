import { createLogger } from "@icecore/shared/lib/logger";
import type {
  CommerceTrackingEventType,
  CommerceTrackingInput,
} from "@icecore/shared/types/commerce-tracking";

/**
 * airi.chat Widget Loader
 * Lightweight script that creates the widget container and loads the main bundle
 */

const widgetLoaderLogger = createLogger("airi-widget-loader");

(function () {
  // Prevent multiple initializations
  const widgetWindow = window as any;
  type AiriChatCommand = [string, ...unknown[]];
  type IdentifyPayload = {
    userId?: string;
    externalId?: string;
    email?: string | null;
    name?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    customData?: Record<string, any>;
  };
  let requestWidgetLoad: (() => void) | null = null;

  const queuedAiriChatCommands: AiriChatCommand[] = Array.isArray(
    widgetWindow.AiriChat?.q,
  )
    ? widgetWindow.AiriChat.q
    : [];

  if (typeof widgetWindow.AiriChat !== "function") {
    const queuedAiriChat = (command: string, ...args: unknown[]) => {
      queuedAiriChatCommands.push([command, ...args]);
      if (command === "track") requestWidgetLoad?.();
    };
    queuedAiriChat.q = queuedAiriChatCommands;
    widgetWindow.AiriChat = queuedAiriChat;
  }

  const queuedSdk = widgetWindow.AiriChat as ((
    command: string,
    ...args: unknown[]
  ) => unknown) & {
    q?: AiriChatCommand[];
    identify?: (userData: IdentifyPayload) => void;
    setContext?: (context: Record<string, any>) => void;
    track?: (
      type: CommerceTrackingEventType,
      payload: CommerceTrackingInput,
    ) => void;
  };
  queuedSdk.q = queuedAiriChatCommands;
  queuedSdk.identify ||= (userData) => queuedSdk("identify", userData);
  queuedSdk.setContext ||= (context) => queuedSdk("setContext", context);
  queuedSdk.track ||= (type, payload) => {
    queuedSdk("track", type, payload);
    requestWidgetLoad?.();
  };

  if (
    widgetWindow.__AIRI_WIDGET_LOADED__ ||
    widgetWindow.__ICECORE_WIDGET_LOADED__
  ) {
    widgetLoaderLogger.warn("airi.widget_loader.duplicate");
    return;
  }

  // Get configuration from multiple sources (in order of priority):
  // 1. Global config object (window.airiWidgetConfig, with legacy window.iceCoreWidgetConfig fallback)
  // 2. Script tag data attributes
  // 3. Auto-detect from any script tag ending with /loader.js
  const isLoaderScript = (
    script: HTMLScriptElement | null | undefined,
  ): script is HTMLScriptElement => {
    return Boolean(script?.src && /\/loader\.js(?:[?#].*)?$/.test(script.src));
  };

  const findLoaderScript = (): HTMLScriptElement | null => {
    const currentScript = document.currentScript as HTMLScriptElement | null;
    if (isLoaderScript(currentScript)) {
      return currentScript;
    }

    const scripts = Array.from(
      document.getElementsByTagName("script"),
    ) as HTMLScriptElement[];

    return (
      scripts.find((script) => script.id === "airi-chat-widget-loader") ||
      scripts.find(
        (script) =>
          Boolean(script.getAttribute("data-client-key")) &&
          isLoaderScript(script),
      ) ||
      scripts.find(
        (script) => isLoaderScript(script) && script.src.includes("widget"),
      ) ||
      null
    );
  };

  const loaderScript = findLoaderScript();
  const globalConfig =
    widgetWindow.airiWidgetConfig || widgetWindow.iceCoreWidgetConfig || {};

  // Extract optional user identification (works with any auth system)
  const userIdentity = {
    userId:
      globalConfig.userId ||
      loaderScript?.dataset?.userId ||
      loaderScript?.getAttribute("data-user-id") ||
      null,
    userEmail:
      globalConfig.userEmail ||
      loaderScript?.dataset?.userEmail ||
      loaderScript?.getAttribute("data-user-email") ||
      null,
    userName:
      globalConfig.userName ||
      loaderScript?.dataset?.userName ||
      loaderScript?.getAttribute("data-user-name") ||
      null,
  };

  const config = {
    clientKey:
      globalConfig.clientKey ||
      loaderScript?.dataset?.clientKey ||
      loaderScript?.getAttribute("data-client-key") ||
      "",
    apiUrl:
      globalConfig.apiUrl ||
      loaderScript?.dataset?.apiUrl ||
      loaderScript?.getAttribute("data-api-url") ||
      undefined,
    theme: globalConfig.theme || loaderScript?.dataset?.theme || "auto",
    position:
      globalConfig.position ||
      loaderScript?.dataset?.position ||
      "bottom-right",
    locale: globalConfig.locale || loaderScript?.dataset?.locale || "en",
    // User identification (optional)
    identity: userIdentity.userId ? userIdentity : null,
  };

  function exposePublicApi(widgetApi: any) {
    const identify = (userData: IdentifyPayload) => {
      if (widgetApi?.updateIdentity) {
        widgetApi.updateIdentity(userData);
      }
    };
    const setContext = (context: Record<string, any>) => {
      widgetWindow.airiAppContext = context;
      widgetWindow.icecoreAppContext = context;
      if (widgetWindow.airiSetContext) {
        widgetWindow.airiSetContext(context);
      }
    };
    const track = (
      type: CommerceTrackingEventType,
      payload: CommerceTrackingInput,
    ) => widgetApi.track(type, payload);
    const getCommerce = () => widgetApi.getCommerce?.() || null;
    const createCartHandoff = (cartId: string, locale?: string) =>
      widgetApi.createCartHandoff(cartId, locale);
    const airiChat = (command: string, ...args: unknown[]) => {
      switch (command) {
        case "identify":
          identify((args[0] || {}) as IdentifyPayload);
          break;
        case "setContext":
          setContext((args[0] || {}) as Record<string, any>);
          break;
        case "track":
          track(
            args[0] as CommerceTrackingEventType,
            (args[1] || {}) as CommerceTrackingInput,
          );
          break;
        default:
          widgetLoaderLogger.warn("airi.widget_loader.unknown_sdk_command", {
            command,
          });
      }
    };

    const airiChatWithHelpers = airiChat as typeof airiChat & {
      identify: typeof identify;
      setContext: typeof setContext;
      track: typeof track;
      getCommerce: typeof getCommerce;
      createCartHandoff: typeof createCartHandoff;
      widget: any;
    };
    airiChatWithHelpers.identify = identify;
    airiChatWithHelpers.setContext = setContext;
    airiChatWithHelpers.track = track;
    airiChatWithHelpers.getCommerce = getCommerce;
    airiChatWithHelpers.createCartHandoff = createCartHandoff;
    airiChatWithHelpers.widget = widgetApi;
    widgetWindow.AiriChat = airiChatWithHelpers;

    if (widgetWindow.AiriWidget) widgetWindow.AiriWidget.identify = identify;
    if (widgetWindow.IceCoreWidget)
      widgetWindow.IceCoreWidget.identify = identify;

    while (queuedAiriChatCommands.length > 0) {
      const [command, ...args] = queuedAiriChatCommands.shift()!;
      airiChat(command, ...args);
    }
  }

  // Validation
  if (!config.clientKey) {
    widgetLoaderLogger.error("airi.widget_loader.missing_client_key");
    return;
  }

  widgetWindow.__AIRI_WIDGET_LOADED__ = true;
  widgetWindow.__ICECORE_WIDGET_LOADED__ = true;

  // Reuse host if it already exists to avoid duplicates
  const existingHost = document.getElementById("airi-widget-host");
  const hostElement =
    existingHost instanceof HTMLElement
      ? existingHost
      : document.createElement("div");
  hostElement.id = "airi-widget-host";
  hostElement.setAttribute("data-airi-widget", "true");
  hostElement.setAttribute("data-icecore-widget", "true");

  // Attach Shadow DOM once
  const shadowRoot =
    hostElement.shadowRoot || hostElement.attachShadow({ mode: "open" });

  // Append to body
  if (!existingHost && document.body) {
    document.body.appendChild(hostElement);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        if (!document.getElementById("airi-widget-host")) {
          document.body.appendChild(hostElement);
        }
      },
      { once: true },
    );
  }

  // Load main widget bundle
  function loadWidget() {
    if (widgetLoadStarted) return;
    widgetLoadStarted = true;

    // Check if widget is already loaded
    const existingWidget =
      widgetWindow.AiriWidget || widgetWindow.IceCoreWidget;
    if (existingWidget) {
      existingWidget.init({
        ...config,
        hostElement,
        shadowRoot,
      });
      exposePublicApi(existingWidget);
      return;
    }

    // Dynamically load widget bundle
    const script = document.createElement("script");
    script.type = "module";

    // Determine widget.js URL - use same origin as loader script
    let widgetUrl = loaderScript?.dataset?.widgetUrl;
    if (!widgetUrl && loaderScript?.src) {
      // Replace loader.js with widget.js in the loader script URL
      widgetUrl = loaderScript.src.replace(/loader\.js(?=$|[?#])/, "widget.js");
    }
    if (!widgetUrl) {
      // Fallback: try to construct from common CDN URL
      widgetUrl = "https://widget.airi.chat/widget.js";
    }

    script.src = widgetUrl;
    script.async = true;
    script.onload = () => {
      const widgetApi = widgetWindow.AiriWidget || widgetWindow.IceCoreWidget;
      if (widgetApi) {
        const initConfig: any = {
          ...config,
          hostElement,
          shadowRoot,
        };

        // Pass apiUrl to widget initialization if provided
        if (config.apiUrl) {
          initConfig.apiUrl = config.apiUrl;
        }

        widgetApi.init(initConfig);
        exposePublicApi(widgetApi);
      }
    };
    script.onerror = () => {
      widgetLoaderLogger.error(
        "airi.widget_loader.bundle_load_failed",
        undefined,
        {
          widgetUrl,
        },
      );
      widgetWindow.__AIRI_WIDGET_LOADED__ = false;
      widgetWindow.__ICECORE_WIDGET_LOADED__ = false;
      widgetLoadStarted = false;
    };
    document.head.appendChild(script);
  }

  let widgetLoadStarted = false;
  requestWidgetLoad = loadWidget;
  if (queuedAiriChatCommands.some(([command]) => command === "track")) {
    loadWidget();
  }

  // Auto-load or lazy load on interaction
  const autoLoad = loaderScript?.dataset?.autoLoad !== "false";
  if (autoLoad) {
    if (document.readyState === "complete") {
      loadWidget();
    } else {
      window.addEventListener("load", loadWidget, { once: true });
    }
  } else {
    // Lazy load on first interaction
    const lazyLoad = () => {
      loadWidget();
      document.removeEventListener("click", lazyLoad);
      document.removeEventListener("scroll", lazyLoad);
    };
    document.addEventListener("click", lazyLoad, { once: true });
    document.addEventListener("scroll", lazyLoad, {
      once: true,
      passive: true,
    });
  }
})();
