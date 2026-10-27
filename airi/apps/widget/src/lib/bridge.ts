/**
 * JavaScript Bridge Helper for Native Apps
 *
 * Provides utilities for iOS/Android apps to communicate with the widget
 * via JavaScript injection into WebView.
 *
 * Usage in native apps:
 *
 * iOS (Swift):
 * ```swift
 * webView.evaluateJavaScript("""
 *     window.airiAppContext = {
 *         currentTab: 'support',
 *         screenName: 'SupportScreen',
 *         route: '/app/support',
 *         metadata: { userId: '123', productId: '456' }
 *     };
 *     if (window.AiriBridge) {
 *         window.AiriBridge.updateContext(window.airiAppContext);
 *     }
 * """)
 * ```
 *
 * Android (Kotlin):
 * ```kotlin
 * webView.evaluateJavascript("""
 *     window.airiAppContext = {
 *         currentTab: 'support',
 *         screenName: 'SupportScreen',
 *         route: '/app/support',
 *         metadata: { userId: '123', productId: '456' }
 *     };
 *     if (window.AiriBridge) {
 *         window.AiriBridge.updateContext(window.airiAppContext);
 *     }
 * """) { }
 * ```
 *
 * React Native:
 * ```javascript
 * const context = {
 *     currentTab: 'support',
 *     screenName: 'SupportScreen',
 *     route: '/app/support',
 *     metadata: { userId: '123' }
 * };
 * webViewRef.current.injectJavaScript(`
 *     window.airiAppContext = ${JSON.stringify(context)};
 *     if (window.AiriBridge) {
 *         window.AiriBridge.updateContext(window.airiAppContext);
 *     }
 * `);
 * ```
 */

import { updateMobileAppContext, type MobileAppContext } from "./mobile";

/**
 * Bridge API exposed to native apps via window.AiriBridge
 */
export interface AiriBridge {
  /**
   * Update app context (tab, route, metadata)
   * Called by native apps when user navigates or tab changes
   */
  updateContext(context: MobileAppContext): void;

  /**
   * Index tab content for RAG
   * Native apps can call this to provide tab-specific content for AI context
   */
  indexTabContent(
    tabName: string,
    content: {
      title?: string;
      text?: string;
      data?: Record<string, any>;
    },
  ): void;

  /**
   * Get current widget state (for debugging)
   */
  getState(): {
    isOpen: boolean;
    currentRoute: string;
    appContext: MobileAppContext | null;
  };

  /**
   * Request tab context extraction (callback-based)
   * Widget can request native app to provide current tab context
   */
  requestTabContext(callback: (context: MobileAppContext | null) => void): void;
}

/**
 * Setup bridge on window object for native apps
 */
export function setupBridge(widgetState: {
  isOpen: boolean;
  getCurrentRoute: () => string;
}): void {
  if (typeof window === "undefined") return;

  const bridge: AiriBridge = {
    updateContext(context: MobileAppContext) {
      console.log("[Airi.chat Bridge] Context updated:", context);
      updateMobileAppContext(context);
    },

    indexTabContent(
      tabName: string,
      content: {
        title?: string;
        text?: string;
        data?: Record<string, any>;
      },
    ) {
      console.log("[Airi.chat Bridge] Tab content indexed:", {
        tabName,
        content,
      });

      // Get current context or create new one
      const currentContext =
        (window as any).airiAppContext ||
        (window as any).icecoreAppContext ||
        {};
      const updatedContext: MobileAppContext = {
        ...currentContext,
        currentTab: tabName,
        tabContent: {
          title: content.title,
          text: content.text,
          data: content.data,
        },
      };

      updateMobileAppContext(updatedContext);
    },

    getState() {
      return {
        isOpen: widgetState.isOpen,
        currentRoute: widgetState.getCurrentRoute(),
        appContext:
          (window as any).airiAppContext ||
          (window as any).icecoreAppContext ||
          null,
      };
    },

    requestTabContext(callback: (context: MobileAppContext | null) => void) {
      // This is a callback-based approach where widget requests context
      // Native apps should listen for this and provide context

      // Post message to native layer (React Native WebView)
      if ((window as any).ReactNativeWebView) {
        (window as any).ReactNativeWebView.postMessage(
          JSON.stringify({
            type: "GET_TAB_CONTEXT",
            timestamp: Date.now(),
          }),
        );
      }

      // iOS WKWebView message handler
      if ((window as any).webkit?.messageHandlers?.getTabContext) {
        (window as any).webkit.messageHandlers.getTabContext.postMessage({
          type: "GET_TAB_CONTEXT",
          timestamp: Date.now(),
        });
      }

      // Android WebView interface
      if ((window as any).Android && (window as any).Android.getTabContext) {
        const context = (window as any).Android.getTabContext();
        if (context) {
          try {
            callback(
              typeof context === "string" ? JSON.parse(context) : context,
            );
          } catch {
            callback(null);
          }
        } else {
          callback(null);
        }
      } else {
        // Fallback: use existing context if available
        setTimeout(() => {
          const context =
            (window as any).airiAppContext || (window as any).icecoreAppContext;
          callback(context || null);
        }, 100);
      }
    },
  };

  // Expose bridge to window. Legacy aliases are kept for existing mobile apps.
  (window as any).AiriBridge = bridge;
  (window as any).IceCoreBridge = bridge;

  // Also expose as window.airi for easier access.
  (window as any).airi = {
    bridge,
    version: "1.0.0",
  };
  (window as any).icecore = (window as any).airi;

  console.log(
    "[Airi.chat Bridge] Bridge initialized and ready for native apps",
  );
}

/**
 * Helper function for native apps to inject context (simplified API)
 * This can be called directly from native code without knowing the full structure
 */
export function exposeSimpleContextAPI(): void {
  if (typeof window === "undefined") return;

  // Simple function that native apps can call
  (window as any).airiSetContext = function (context: any) {
    if (typeof window !== "undefined" && (window as any).AiriBridge) {
      (window as any).AiriBridge.updateContext(context);
    }
  };
  (window as any).icecoreSetContext = (window as any).airiSetContext;

  // Simple function to index tab content
  (window as any).airiIndexTab = function (tabName: string, content: any) {
    if (typeof window !== "undefined" && (window as any).AiriBridge) {
      (window as any).AiriBridge.indexTabContent(tabName, content);
    }
  };
  (window as any).icecoreIndexTab = (window as any).airiIndexTab;
}

export type IceCoreBridge = AiriBridge;
