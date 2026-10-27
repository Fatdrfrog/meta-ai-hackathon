/**
 * Mobile and WebView detection utilities
 * Helps identify the widget's running environment for mobile-specific optimizations
 */

/**
 * Detect if running in a mobile browser environment
 */
export function isMobile(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  // Check user agent for mobile patterns
  const userAgent =
    navigator.userAgent || navigator.vendor || (window as any).opera;
  const mobileRegex =
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;

  return mobileRegex.test(userAgent);
}

/**
 * Detect if running in an iOS environment
 */
export function isIOS(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const userAgent =
    navigator.userAgent || navigator.vendor || (window as any).opera;
  return /iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream;
}

/**
 * Detect if running in an Android environment
 */
export function isAndroid(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  return /Android/i.test(navigator.userAgent);
}

/**
 * Detect if running in a WebView (iOS or Android)
 * Common patterns for WebView user agents
 */
export function isWebView(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent || "";

  // iOS WebView detection
  if (isIOS()) {
    // In iOS WebView, Safari is not present in user agent
    // Also check for WKWebView or UIWebView patterns
    const hasSafari = /Safari/i.test(userAgent);
    const hasCriOS = /CriOS/i.test(userAgent); // Chrome on iOS
    const hasFxiOS = /FxiOS/i.test(userAgent); // Firefox on iOS

    // If iOS but no Safari/Chrome/Firefox browser indicators, likely WebView
    if (
      !hasSafari &&
      !hasCriOS &&
      !hasFxiOS &&
      (userAgent.includes("Mobile") || userAgent.includes("iPhone"))
    ) {
      return true;
    }
  }

  // Android WebView detection
  if (isAndroid()) {
    // Android WebView typically contains "wv" in user agent
    // Or missing common browser indicators
    if (
      userAgent.includes("wv") ||
      (!userAgent.includes("Chrome") && userAgent.includes("Android"))
    ) {
      return true;
    }
  }

  // Additional WebView indicators (common patterns)
  const webViewPatterns = [
    /WKWebView/i,
    /WebView/i,
    /wv/i,
    /Cordova/i,
    /PhoneGap/i,
    /ReactNative/i,
  ];

  return webViewPatterns.some((pattern) => pattern.test(userAgent));
}

/**
 * Check if file input capture attribute should be used
 * Mobile devices benefit from camera/gallery access
 */
export function shouldUseCapture(): boolean {
  return isMobile() || isWebView();
}

/**
 * Get file input accept attribute optimized for mobile
 */
export function getMobileFileAccept(): string {
  // Standard image formats that work well on mobile
  return "image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif";
}

/**
 * Mobile app context interface
 * Injected by native apps via JavaScript bridge
 */
export interface MobileAppContext {
  currentTab?: string;
  screenName?: string;
  route?: string;
  metadata?: Record<string, any>;
  // Tab-specific content for RAG indexing
  tabContent?: {
    title?: string;
    text?: string;
    data?: Record<string, any>;
  };
}

/**
 * Get mobile app context from window object
 * Native apps should inject this via: window.airiAppContext = { ... }
 */
export function getMobileAppContext(): MobileAppContext | null {
  if (typeof window === "undefined") return null;

  const context =
    (window as any).airiAppContext || (window as any).icecoreAppContext;
  if (!context || typeof context !== "object") return null;

  return {
    currentTab: context.currentTab,
    screenName: context.screenName,
    route: context.route,
    metadata: context.metadata,
    tabContent: context.tabContent,
  };
}

/**
 * Update mobile app context (called by native bridge)
 */
export function updateMobileAppContext(context: MobileAppContext): void {
  if (typeof window === "undefined") return;

  (window as any).airiAppContext = context;
  // Legacy alias kept for existing mobile integrations.
  (window as any).icecoreAppContext = context;

  // Dispatch event so widget can react to context changes
  window.dispatchEvent(
    new CustomEvent("airi:context:updated", { detail: context }),
  );
  window.dispatchEvent(
    new CustomEvent("icecore:context:updated", { detail: context }),
  );
}

/**
 * Get effective route/URL for conversation tracking
 * Prioritizes app context route over window.location
 */
export function getEffectiveRoute(): string {
  const appContext = getMobileAppContext();

  // If we're in a mobile app, use route from context
  if (appContext?.route) {
    return appContext.route;
  }

  // Fallback to window.location for web
  if (typeof window !== "undefined" && window.location) {
    return window.location.pathname || window.location.href;
  }

  return "/";
}

/**
 * Get effective page identifier for conversation grouping
 * Combines route with tab/screen name for mobile apps
 */
export function getEffectivePageIdentifier(): string {
  const appContext = getMobileAppContext();

  if (appContext) {
    // In mobile app: combine route + tab for unique page identification
    const parts = [appContext.route || "/"];
    if (appContext.currentTab) {
      parts.push(`tab:${appContext.currentTab}`);
    }
    if (appContext.screenName) {
      parts.push(`screen:${appContext.screenName}`);
    }
    return parts.join("|");
  }

  // Web: use pathname or href
  if (typeof window !== "undefined" && window.location) {
    return window.location.pathname || window.location.href;
  }

  return "/";
}
