/**
 * Airi.chat Widget Analytics
 *
 * Client-side analytics tracking for website behavior.
 * Tracks pageviews, sessions, interactions, and performance metrics.
 */

import { STORAGE_KEYS } from "./storage";

export interface AnalyticsConfig {
  workspaceId: string;
  companyId: string;
  clientKey: string;
  apiUrl: string;
  enabled?: boolean;
}

export interface AnalyticsEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

interface SessionData {
  sessionId: string;
  startTime: number;
  pageCount: number;
  lastActivityTime: number;
}

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const BATCH_SIZE = 10;
const BATCH_TIMEOUT = 5000; // 5 seconds
const SESSION_STORAGE_KEY = STORAGE_KEYS.SESSION;
const VISITOR_STORAGE_KEY = STORAGE_KEYS.VISITOR_ID;

export class WidgetAnalytics {
  private config: AnalyticsConfig;
  private eventQueue: AnalyticsEvent[] = [];
  private batchTimer: number | null = null;
  private sessionData: SessionData | null = null;
  private visitorId: string;
  private isTracking = false;
  private performanceObserver: PerformanceObserver | null = null;

  constructor(config: AnalyticsConfig) {
    this.config = config;
    this.visitorId = this.getOrCreateVisitorId();

    // Don't track in iframes
    if (typeof window !== "undefined" && window.top !== window.self) {
      return;
    }

    // Respect Do Not Track
    if (this.isDNTEnabled()) {
      return;
    }

    this.initializeSession();
    this.setupEventListeners();
  }

  /**
   * Check if Do Not Track is enabled
   */
  private isDNTEnabled(): boolean {
    if (typeof navigator === "undefined") return false;
    const dnt =
      navigator.doNotTrack ||
      (window as any).doNotTrack ||
      (navigator as any).msDoNotTrack;
    return dnt === "1" || dnt === "yes";
  }

  /**
   * Get or create visitor ID (reuses storage key from storage.ts)
   */
  private getOrCreateVisitorId(): string {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.VISITOR_ID);
      if (stored) return stored;

      const newId = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEYS.VISITOR_ID, newId);
      return newId;
    } catch {
      // Fallback if localStorage is blocked
      return crypto.randomUUID();
    }
  }

  /**
   * Initialize or restore session
   */
  private initializeSession(): void {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEYS.SESSION);
      if (stored) {
        const session: SessionData = JSON.parse(stored);
        const timeSinceLastActivity = Date.now() - session.lastActivityTime;

        // Resume session if within timeout
        if (timeSinceLastActivity < SESSION_TIMEOUT) {
          this.sessionData = session;
          this.updateSessionActivity();
          return;
        }
      }

      // Create new session
      this.startNewSession();
    } catch {
      this.startNewSession();
    }
  }

  /**
   * Start a new session
   */
  private startNewSession(): void {
    this.sessionData = {
      sessionId: crypto.randomUUID(),
      startTime: Date.now(),
      pageCount: 0,
      lastActivityTime: Date.now(),
    };
    this.saveSession();
    this.trackEvent("widget_session_start", {
      session_id: this.sessionData.sessionId,
    });
  }

  /**
   * Update session activity timestamp
   */
  private updateSessionActivity(): void {
    if (!this.sessionData) return;
    this.sessionData.lastActivityTime = Date.now();
    this.saveSession();
  }

  /**
   * Save session to storage
   */
  private saveSession(): void {
    if (!this.sessionData) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEYS.SESSION,
        JSON.stringify(this.sessionData),
      );
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    if (typeof window === "undefined") return;

    // Track visibility changes (user switching tabs)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.flush(); // Send pending events when tab becomes hidden
      } else {
        this.updateSessionActivity();
      }
    });

    // Track session end on page unload
    window.addEventListener("beforeunload", () => {
      this.trackSessionEnd();
      this.flush(true); // Force flush with sendBeacon
    });

    // Track page visibility time
    let visibilityStartTime = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        const duration = Date.now() - visibilityStartTime;
        this.trackEvent("widget_page_visible_time", {
          duration_ms: duration,
          page_url: window.location.pathname,
        });
      } else {
        visibilityStartTime = Date.now();
      }
    });

    // Track scroll depth milestones
    let maxScrollDepth = 0;
    const trackScrollDepth = this.debounce(() => {
      const scrollPercentage = Math.round(
        ((window.scrollY + window.innerHeight) /
          document.documentElement.scrollHeight) *
          100,
      );

      // Track 25%, 50%, 75%, 100% milestones
      const milestones = [25, 50, 75, 100];
      for (const milestone of milestones) {
        if (scrollPercentage >= milestone && maxScrollDepth < milestone) {
          maxScrollDepth = milestone;
          this.trackEvent("widget_scroll_depth", {
            depth_percentage: milestone,
            page_url: window.location.pathname,
          });
        }
      }
    }, 500);

    window.addEventListener("scroll", trackScrollDepth, { passive: true });

    // Track performance metrics
    this.trackPerformanceMetrics();

    // Detect SPA route changes
    this.setupRouteChangeDetection();
  }

  /**
   * Setup route change detection for SPAs
   */
  private setupRouteChangeDetection(): void {
    if (typeof window === "undefined") return;

    let lastPath = window.location.pathname;

    // Listen for pushState/replaceState
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.handleRouteChange(lastPath, window.location.pathname);
      lastPath = window.location.pathname;
    };

    history.replaceState = (...args) => {
      originalReplaceState.apply(history, args);
      this.handleRouteChange(lastPath, window.location.pathname);
      lastPath = window.location.pathname;
    };

    // Listen for popstate (back/forward buttons)
    window.addEventListener("popstate", () => {
      this.handleRouteChange(lastPath, window.location.pathname);
      lastPath = window.location.pathname;
    });
  }

  /**
   * Handle route changes in SPAs
   */
  private handleRouteChange(from: string, to: string): void {
    if (from !== to) {
      this.trackPageview();
    }
  }

  /**
   * Track performance metrics using Performance API
   */
  private trackPerformanceMetrics(): void {
    if (typeof window === "undefined" || !window.performance) return;

    // Wait for page load
    window.addEventListener("load", () => {
      setTimeout(() => {
        const perfData = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming;
        if (perfData) {
          this.trackEvent("widget_performance", {
            page_url: window.location.pathname,
            page_load_time: Math.round(
              perfData.loadEventEnd - perfData.fetchStart,
            ),
            dns_time: Math.round(
              perfData.domainLookupEnd - perfData.domainLookupStart,
            ),
            tcp_time: Math.round(perfData.connectEnd - perfData.connectStart),
            ttfb: Math.round(perfData.responseStart - perfData.requestStart),
            dom_interactive: Math.round(
              perfData.domInteractive - perfData.fetchStart,
            ),
            dom_complete: Math.round(
              perfData.domComplete - perfData.fetchStart,
            ),
          });
        }

        // Track Core Web Vitals if available
        this.trackWebVitals();
      }, 0);
    });
  }

  /**
   * Track Core Web Vitals (LCP, FID, CLS)
   */
  private trackWebVitals(): void {
    if (typeof window === "undefined" || !window.PerformanceObserver) return;

    try {
      // Largest Contentful Paint (LCP)
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        this.trackEvent("widget_web_vital_lcp", {
          value: Math.round(lastEntry.startTime),
          page_url: window.location.pathname,
        });
      });
      lcpObserver.observe({ entryTypes: ["largest-contentful-paint"] });

      // First Input Delay (FID)
      const fidObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry: any) => {
          this.trackEvent("widget_web_vital_fid", {
            value: Math.round(entry.processingStart - entry.startTime),
            page_url: window.location.pathname,
          });
        });
      });
      fidObserver.observe({ entryTypes: ["first-input"] });

      // Cumulative Layout Shift (CLS)
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry: any) => {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        });
      });
      clsObserver.observe({ entryTypes: ["layout-shift"] });

      // Report CLS on page unload
      window.addEventListener("beforeunload", () => {
        this.trackEvent("widget_web_vital_cls", {
          value: Math.round(clsValue * 1000) / 1000,
          page_url: window.location.pathname,
        });
      });
    } catch {
      // PerformanceObserver not supported
    }
  }

  /**
   * Start analytics tracking
   */
  start(): void {
    if (this.isTracking) return;
    this.isTracking = true;
    this.trackPageview();
  }

  /**
   * Stop analytics tracking
   */
  stop(): void {
    this.isTracking = false;
    this.flush();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Track a pageview
   */
  trackPageview(url?: string): void {
    if (!this.isTracking || !this.sessionData) return;

    this.sessionData.pageCount++;
    this.updateSessionActivity();

    this.trackEvent("widget_pageview", {
      page_url: url || window.location.pathname,
      referrer: document.referrer || "(direct)",
      page_title: document.title,
      session_page_number: this.sessionData.pageCount,
    });
  }

  /**
   * Track session end
   */
  private trackSessionEnd(): void {
    if (!this.sessionData) return;

    const duration = Math.min(
      Date.now() - this.sessionData.startTime,
      SESSION_TIMEOUT,
    );
    this.trackEvent("widget_session_end", {
      session_id: this.sessionData.sessionId,
      duration_ms: duration,
      page_count: this.sessionData.pageCount,
    });
  }

  /**
   * Track a custom event
   */
  trackEvent(eventName: string, properties: Record<string, any> = {}): void {
    if (!this.config.enabled) return;

    const event: AnalyticsEvent = {
      event: eventName,
      properties: {
        ...this.getStandardProperties(),
        ...properties,
        // Assign once when queued, so transport retries keep the same identity.
        event_id: crypto.randomUUID(),
      },
      timestamp: new Date().toISOString(),
    };

    this.eventQueue.push(event);

    // Batch events
    if (this.eventQueue.length >= BATCH_SIZE) {
      this.flush();
    } else if (!this.batchTimer) {
      this.batchTimer = window.setTimeout(() => {
        this.flush();
      }, BATCH_TIMEOUT);
    }
  }

  /**
   * Get standard properties for all events
   */
  private getStandardProperties(): Record<string, any> {
    return {
      workspace_id: this.config.workspaceId,
      company_id: this.config.companyId,
      visitor_id: this.visitorId,
      session_id: this.sessionData?.sessionId,
      page_url: window.location.pathname,
      page_referrer: document.referrer || "(direct)",
      // Device properties
      screen_width: window.screen.width,
      screen_height: window.screen.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      user_agent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /**
   * Flush event queue to server
   */
  private flush(useBeacon = false): void {
    if (this.eventQueue.length === 0) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const payload = {
      clientKey: this.config.clientKey,
      events,
    };

    const url = `${this.config.apiUrl}/analytics`;

    if (useBeacon && navigator.sendBeacon) {
      // Use sendBeacon for reliable delivery on page unload
      const blob = new Blob([JSON.stringify(payload)], {
        type: "application/json",
      });
      navigator.sendBeacon(url, blob);
    } else {
      // Regular fetch
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "omit",
        keepalive: true, // Keep request alive even if page unloads
      }).catch(() => {
        // Silently fail - don't break the page
      });
    }
  }

  /**
   * Utility: Debounce function
   */
  private debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number,
  ): (...args: Parameters<T>) => void {
    let timeout: number | null = null;
    return (...args: Parameters<T>) => {
      if (timeout) clearTimeout(timeout);
      timeout = window.setTimeout(() => func(...args), wait);
    };
  }
}
