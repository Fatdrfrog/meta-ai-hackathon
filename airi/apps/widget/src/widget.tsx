import { render } from "preact";
import { WidgetShell } from "./components/WidgetShell";
import notionStyles from "./styles/notion-simple.css?inline";
import { pickSupportedWidgetLanguage } from "@icecore/shared/lib/widget-localization";
import type {
  CommerceTrackingEventType,
  CommerceTrackingInput,
} from "@icecore/shared/types/commerce-tracking";
import { WidgetCommerce } from "./lib/commerce";
import type { UserIdentity, WidgetConfig, WidgetConfigResponse } from "./types";

interface InitOptions extends WidgetConfig {
  hostElement?: HTMLElement;
  shadowRoot?: ShadowRoot;
  apiUrl?: string; // Allow overriding API URL for development
}

class AiriWidget {
  private shadowRoot: ShadowRoot | null = null;
  private container: HTMLElement | null = null;
  private config: WidgetConfig = {};
  private serverConfig: WidgetConfigResponse["config"] | null = null;
  private isInitialized = false;
  private apiUrl: string;
  private commerce: WidgetCommerce | null = null;
  private themeListener: ((e: StorageEvent) => void) | null = null;

  constructor() {
    // API URL will be resolved in init() with proper priority
    this.apiUrl = "";
  }

  /** Production API URL — used when no override is provided. Never localhost. */
  private static readonly PRODUCTION_API_URL =
    "https://www.airi.chat/api/widget";

  /**
   * Resolve API URL with priority chain:
   * 1. Config object passed by loader (data-api-url)
   * 2. Global window.__AIRI_WIDGET_API_URL__ (or legacy __ICECORE_WIDGET_API_URL__)
   * 3. Build-time VITE_API_URL
   * 4. Fallback: production URL (never localhost)
   */
  private resolveApiUrl(configUrl?: string): string {
    // Priority 1: Explicit config from loader
    if (configUrl) {
      console.log("Airi.chat Widget: Using API URL from config:", configUrl);
      return configUrl;
    }

    // Priority 2: Global window variable
    if (
      typeof window !== "undefined" &&
      ((window as any).__AIRI_WIDGET_API_URL__ ||
        (window as any).__ICECORE_WIDGET_API_URL__)
    ) {
      const globalUrl =
        (window as any).__AIRI_WIDGET_API_URL__ ||
        (window as any).__ICECORE_WIDGET_API_URL__;
      console.log(
        "Airi.chat Widget: Using API URL from window global:",
        globalUrl,
      );
      return globalUrl;
    }

    // Priority 3: Build-time environment variable
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) {
      const envUrl = import.meta.env.VITE_API_URL;
      console.log("Airi.chat Widget: Using API URL from environment:", envUrl);
      return envUrl;
    }

    // Priority 4: Production only — never use relative /api/widget (would hit localhost when testing)
    console.log(
      "Airi.chat Widget: Using production API URL:",
      AiriWidget.PRODUCTION_API_URL,
    );
    return AiriWidget.PRODUCTION_API_URL;
  }

  async init(options: InitOptions = {}) {
    if (this.isInitialized) {
      console.warn("Airi.chat Widget is already initialized");
      return this;
    }

    // Resolve API URL using priority chain
    this.apiUrl = this.resolveApiUrl(options.apiUrl);

    this.config = options;
    this.shadowRoot = options.shadowRoot || null;

    if (!this.shadowRoot && options.hostElement) {
      this.shadowRoot = options.hostElement.attachShadow({ mode: "open" });
    }

    if (!this.shadowRoot) {
      console.error("No shadow root available for widget initialization");
      return;
    }

    if (!options.clientKey) {
      console.error("Airi.chat Widget: clientKey is required");
      return;
    }

    this.commerce = new WidgetCommerce({
      clientKey: options.clientKey,
      apiUrl: this.apiUrl,
    });

    // Fetch server configuration
    await this.fetchConfig();

    this.injectStyles();
    this.applyDarkMode(); // Apply theme on init
    this.setupThemeListener(); // Listen for theme changes
    this.renderWidget();
    this.isInitialized = true;
    return this;
  }

  updateIdentity(userData: {
    userId?: string;
    externalId?: string;
    email?: string | null;
    name?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    customData?: Record<string, any>;
  }): void {
    const userId = userData.userId || userData.externalId;
    if (!userId) {
      console.warn("Airi.chat Widget: identify requires userId or externalId");
      return;
    }

    const identity: UserIdentity = {
      userId,
      userEmail: userData.userEmail ?? userData.email ?? null,
      userName: userData.userName ?? userData.name ?? null,
      customData: userData.customData,
    };

    this.config = {
      ...this.config,
      identity,
    };

    if (this.isInitialized) {
      this.renderWidget();
    }
  }

  identify(userData: Parameters<AiriWidget["updateIdentity"]>[0]): void {
    this.updateIdentity(userData);
  }

  track(
    type: CommerceTrackingEventType,
    payload: CommerceTrackingInput,
  ): string {
    if (!this.commerce) {
      throw new Error("Airi.chat Widget commerce is not initialized");
    }
    return this.commerce.track(type, payload);
  }

  getCommerce(): WidgetCommerce | null {
    return this.commerce;
  }

  createCartHandoff(cartId: string, locale?: string): Promise<string> {
    if (!this.commerce) {
      return Promise.reject(
        new Error("Airi.chat Widget commerce is not initialized"),
      );
    }
    return this.commerce.createHandoff(cartId, locale);
  }

  private async fetchConfig(): Promise<void> {
    if (!this.config.clientKey) {
      console.error("Airi.chat Widget: clientKey is required");
      return;
    }

    try {
      const requestedLocale = pickSupportedWidgetLanguage([
        this.config.locale,
        typeof navigator !== "undefined" ? navigator.languages : [],
        typeof navigator !== "undefined" ? navigator.language : null,
      ]);
      const response = await fetch(
        `${this.apiUrl}/config?client_key=${encodeURIComponent(this.config.clientKey)}&locale=${encodeURIComponent(requestedLocale)}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "omit", // Widget doesn't need cookies
        },
      );

      if (!response.ok) {
        const error = await response.json();
        console.error("Airi.chat Widget: Failed to fetch config:", error.error);
        return;
      }

      const data: WidgetConfigResponse = await response.json();
      if (data.success && data.config) {
        this.serverConfig = data.config;

        // Apply theme CSS variables
        this.applyTheme(data.config.theme);

        console.log("Airi.chat Widget: Config loaded successfully", {
          workspace: data.config.workspaceId,
          locale: data.config.locale,
        });
      }
    } catch (error) {
      console.error("Airi.chat Widget: Network error fetching config:", error);
    }
  }

  private applyTheme(theme: WidgetConfigResponse["config"]["theme"]): void {
    if (!this.shadowRoot) return;

    // Apply theme CSS variables to :host (shadow root).
    const hostElement = this.shadowRoot.host as HTMLElement;
    hostElement.style.setProperty("--icecore-primary", theme.primaryColor);
    hostElement.style.setProperty(
      "--icecore-bubble-bg",
      theme.bubbleColor || theme.primaryColor,
    );
    hostElement.style.setProperty(
      "--icecore-header-bg",
      theme.headerBgColor || "#FFFFFF",
    );
    hostElement.style.setProperty(
      "--icecore-header-text",
      theme.headerTextColor || "#111827",
    );
  }

  /**
   * Get theme from parent page's localStorage and HTML element
   * next-themes stores theme as 'theme' key and may add 'dark' class to html
   */
  private getThemeFromStorage(): "light" | "dark" | "system" {
    if (typeof window === "undefined" || typeof document === "undefined")
      return "light";

    try {
      // First check if html element has 'dark' class (next-themes often uses this)
      const htmlElement = document.documentElement;
      if (htmlElement.classList.contains("dark")) {
        return "dark";
      }
      if (htmlElement.classList.contains("light")) {
        return "light";
      }

      // Check data-theme attribute
      const dataTheme = htmlElement.getAttribute("data-theme");
      if (dataTheme === "dark" || dataTheme === "light") {
        return dataTheme;
      }

      // Access parent window's localStorage (same origin)
      const storage = window.localStorage;
      const theme = storage.getItem("theme");

      if (theme === "dark" || theme === "light") {
        return theme;
      }

      // Handle 'system' theme by checking prefers-color-scheme
      if (theme === "system" || !theme) {
        if (typeof window.matchMedia !== "undefined") {
          return window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
        }
        return "light";
      }

      return "light";
    } catch (error) {
      // localStorage might be blocked, fallback to system preference
      if (typeof window.matchMedia !== "undefined") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      }
      return "light";
    }
  }

  /**
   * Apply dark mode class to shadow root based on localStorage theme
   */
  private applyDarkMode(): void {
    if (!this.shadowRoot) return;

    const theme = this.getThemeFromStorage();
    const hostElement = this.shadowRoot.host as HTMLElement;

    if (theme === "dark") {
      hostElement.setAttribute("data-theme", "dark");
    } else {
      hostElement.setAttribute("data-theme", "light");
    }
  }

  /**
   * Listen for theme changes in localStorage and DOM
   * next-themes triggers storage events and may change html class
   */
  private setupThemeListener(): void {
    if (typeof window === "undefined" || typeof document === "undefined")
      return;

    this.themeListener = (e: StorageEvent) => {
      // Listen for changes to 'theme' key in localStorage
      if (e.key === "theme" || e.key === null) {
        this.applyDarkMode();
      }
    };

    window.addEventListener("storage", this.themeListener);

    // Also listen for custom theme change events (next-themes may dispatch these)
    const customListener = () => {
      this.applyDarkMode();
    };
    window.addEventListener("theme-change", customListener);

    // Listen for system theme changes
    if (typeof window.matchMedia !== "undefined") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", customListener);
    }

    // Watch for changes to html element's class or data-theme attribute
    // next-themes often adds/removes 'dark' class on html
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (
            mutation.type === "attributes" &&
            (mutation.attributeName === "class" ||
              mutation.attributeName === "data-theme")
          ) {
            this.applyDarkMode();
            break;
          }
        }
      });

      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
      });
    }
  }

  private injectStyles() {
    if (!this.shadowRoot) return;

    const style = document.createElement("style");
    style.textContent = notionStyles;
    this.shadowRoot.appendChild(style);
  }

  private renderWidget() {
    if (!this.shadowRoot) return;

    if (!this.container) {
      this.container = document.createElement("div");
      this.shadowRoot.appendChild(this.container);
    }

    // Pass resolved apiUrl so WidgetShell never falls back to /api/widget (localhost)
    const configWithApiUrl = { ...this.config, apiUrl: this.apiUrl };
    render(
      <WidgetShell
        config={configWithApiUrl}
        serverConfig={this.serverConfig}
        commerce={this.commerce || undefined}
      />,
      this.container,
    );
  }

  destroy() {
    this.commerce?.destroy();
    this.commerce = null;

    // Clean up theme listener
    if (this.themeListener && typeof window !== "undefined") {
      window.removeEventListener("storage", this.themeListener);
      this.themeListener = null;
    }

    if (this.container) {
      render(null, this.container);
      this.container.remove();
      this.container = null;
    }

    if (this.shadowRoot) {
      this.shadowRoot = null;
    }
    this.isInitialized = false;
    this.serverConfig = null;
  }
}

// Export for global access
if (typeof window !== "undefined") {
  const widget = new AiriWidget();
  (window as any).AiriWidget = widget;
  // Legacy alias kept so existing embeds do not break.
  (window as any).IceCoreWidget = widget;
}

const IceCoreWidget = AiriWidget;

export { AiriWidget, IceCoreWidget };
export default AiriWidget;
