/**
 * RAG (Retrieval-Augmented Generation) Indexing Utilities
 *
 * Extracts and indexes tab/content from mobile apps for AI context
 */

import { getMobileAppContext, type MobileAppContext } from "./mobile";

/**
 * Indexed content entry
 */
export interface IndexedContent {
  tabName: string;
  screenName?: string;
  route: string;
  title?: string;
  text?: string;
  structuredData?: Record<string, any>;
  indexedAt: string;
  timestamp: number;
}

/**
 * Extract text content from DOM (for web pages)
 */
export function extractPageContent(): {
  title: string;
  text: string;
  structuredData: Record<string, any>;
} {
  if (typeof document === "undefined") {
    return { title: "", text: "", structuredData: {} };
  }

  // Extract title
  const title = document.title || "";

  // Extract main content text (skip scripts, styles, hidden elements)
  const mainContent = document.body || document.documentElement;
  const textContent = extractTextFromElement(mainContent);

  // Extract structured data from meta tags
  const structuredData: Record<string, any> = {};

  // Meta tags
  const metaTags = document.querySelectorAll("meta[property], meta[name]");
  metaTags.forEach((meta) => {
    const property = meta.getAttribute("property") || meta.getAttribute("name");
    const content = meta.getAttribute("content");
    if (property && content) {
      structuredData[property] = content;
    }
  });

  // Open Graph data
  const ogData: Record<string, string> = {};
  metaTags.forEach((meta) => {
    const property = meta.getAttribute("property");
    if (property?.startsWith("og:")) {
      const key = property.replace("og:", "");
      const content = meta.getAttribute("content");
      if (content) {
        ogData[key] = content;
      }
    }
  });
  if (Object.keys(ogData).length > 0) {
    structuredData.og = ogData;
  }

  // JSON-LD structured data
  const jsonLdScripts = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  jsonLdScripts.forEach((script) => {
    try {
      const data = JSON.parse(script.textContent || "");
      if (data["@type"]) {
        structuredData["jsonLd"] = data;
      }
    } catch {
      // Ignore parse errors
    }
  });

  return {
    title,
    text: textContent,
    structuredData,
  };
}

/**
 * Extract text content from a DOM element (excluding scripts, styles, hidden elements)
 */
function extractTextFromElement(element: Element | null): string {
  if (!element) return "";

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // Skip script and style elements
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;

      const tagName = parent.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(tagName)) {
        return NodeFilter.FILTER_REJECT;
      }

      // Skip hidden elements
      const style = window.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") {
        return NodeFilter.FILTER_REJECT;
      }

      // Skip empty or whitespace-only text
      if (!node.textContent || !node.textContent.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textParts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text) {
      textParts.push(text);
    }
  }

  return textParts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Get indexed content from mobile app context
 */
export function getIndexedContentFromAppContext(): IndexedContent | null {
  const appContext = getMobileAppContext();
  if (!appContext || !appContext.tabContent) {
    return null;
  }

  return {
    tabName: appContext.currentTab || "unknown",
    screenName: appContext.screenName,
    route: appContext.route || "/",
    title: appContext.tabContent.title,
    text: appContext.tabContent.text,
    structuredData: appContext.tabContent.data || {},
    indexedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
}

/**
 * Get indexed content (from app context or page extraction)
 */
export function getIndexedContent(): IndexedContent | null {
  // Try app context first (mobile app)
  const appContent = getIndexedContentFromAppContext();
  if (appContent) {
    return appContent;
  }

  // Fallback to page extraction (web)
  if (typeof document !== "undefined") {
    const pageContent = extractPageContent();
    if (pageContent.text || pageContent.title) {
      return {
        tabName: "web-page",
        route: window.location.pathname || window.location.href,
        title: pageContent.title,
        text: pageContent.text,
        structuredData: pageContent.structuredData,
        indexedAt: new Date().toISOString(),
        timestamp: Date.now(),
      };
    }
  }

  return null;
}

/**
 * Format indexed content for AI context (RAG)
 * Returns formatted string that can be included in AI prompts
 */
export function formatContentForRAG(content: IndexedContent): string {
  const parts: string[] = [];

  if (content.title) {
    parts.push(`Page Title: ${content.title}`);
  }

  if (content.tabName && content.tabName !== "web-page") {
    parts.push(`Tab/Screen: ${content.tabName}`);
    if (content.screenName) {
      parts.push(`Screen: ${content.screenName}`);
    }
  }

  if (content.route) {
    parts.push(`Route: ${content.route}`);
  }

  if (content.text) {
    // Truncate long text (keep first 2000 chars)
    const truncatedText =
      content.text.length > 2000
        ? content.text.substring(0, 2000) + "..."
        : content.text;
    parts.push(`Content: ${truncatedText}`);
  }

  // Add structured data if available
  if (
    content.structuredData &&
    Object.keys(content.structuredData).length > 0
  ) {
    const dataStr = JSON.stringify(content.structuredData, null, 2);
    if (dataStr.length < 500) {
      parts.push(`Structured Data: ${dataStr}`);
    }
  }

  return parts.join("\n");
}

/**
 * Get RAG context string for current page/tab
 * Ready to include in AI conversation context
 */
export function getRAGContext(): string {
  const content = getIndexedContent();
  if (!content) {
    return "";
  }

  return formatContentForRAG(content);
}
