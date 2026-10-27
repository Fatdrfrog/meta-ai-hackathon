import { h, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ExternalLinkIcon } from "../assets/icons";

/**
 * Article content from API
 */
export interface HelpArticleContent {
  id: string;
  title: string;
  content_html: string;
  updatedAt: string;
}

export type ArticleViewStatus = "idle" | "loading" | "error" | "success";

interface ArticleViewProps {
  articleId: string;
  articleTitle: string;
  articleUrl: string;
  clientKey: string;
  apiUrl: string;
  onBack: () => void;
}

const SAFE_ARTICLE_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "u",
  "ul",
]);
const SAFE_ARTICLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const YOUTUBE_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";

function sanitizeArticleUrl(value: string | null, imageOnly = false) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed, "https://airi.chat");
    const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
    if (imageOnly && parsed.protocol === "data:") {
      return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(trimmed)
        ? trimmed
        : null;
    }
    if (hasProtocol && !SAFE_ARTICLE_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function getSafeYoutubeEmbedUrl(value: string | null) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_EMBED_HOSTS.has(host)) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 2 ||
      parts[0] !== "embed" ||
      !YOUTUBE_VIDEO_ID.test(parts[1])
    ) {
      return null;
    }

    return `https://${host}/embed/${parts[1]}${parsed.search}`;
  } catch {
    return null;
  }
}

function isYoutubeVideoWrapper(element: Element | null) {
  return (
    element?.tagName.toLowerCase() === "div" &&
    element.hasAttribute("data-youtube-video")
  );
}

function renderSafeArticleNode(node: Node, key: string): ComponentChildren {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (tag === "iframe") {
    const src = getSafeYoutubeEmbedUrl(element.getAttribute("src"));
    if (!src) return null;

    const iframe = h("iframe", {
      key: `${key}-iframe`,
      className: "widget-article-youtube",
      src,
      title: element.getAttribute("title") || "YouTube video",
      allow: YOUTUBE_IFRAME_ALLOW,
      allowFullScreen: true,
      loading: "lazy",
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    return isYoutubeVideoWrapper(element.parentElement)
      ? iframe
      : h("div", { key, "data-youtube-video": "" }, iframe);
  }

  const children = Array.from(element.childNodes).map((child, index) =>
    renderSafeArticleNode(child, `${key}-${index}`),
  );

  if (!SAFE_ARTICLE_TAGS.has(tag)) {
    return children;
  }

  if (isYoutubeVideoWrapper(element)) {
    return h("div", { key, "data-youtube-video": "" }, children);
  }

  if (tag === "a") {
    const href = sanitizeArticleUrl(element.getAttribute("href"));
    return href
      ? h(
          "a",
          {
            key,
            href,
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
          children,
        )
      : h("span", { key }, children);
  }

  if (tag === "img") {
    const src = sanitizeArticleUrl(element.getAttribute("src"), true);
    if (!src) return null;
    return h("img", {
      key,
      src,
      alt: element.getAttribute("alt") || "",
      loading: "lazy",
      decoding: "async",
    });
  }

  return h(tag, { key }, children);
}

function renderSafeArticleHtml(html: string): ComponentChildren {
  if (typeof DOMParser === "undefined") {
    return "";
  }

  const parsed = new DOMParser().parseFromString(
    `<article>${html}</article>`,
    "text/html",
  );
  const root = parsed.body.firstElementChild;
  return Array.from(root?.childNodes || []).map((node, index) =>
    renderSafeArticleNode(node, `article-${index}`),
  );
}

/**
 * ArticleView displays a single article's content in the widget.
 *
 * - Lazy loads content when mounted
 * - Renders sanitized HTML from backend
 * - Includes "Open in new tab" option
 */
export const ArticleView = ({
  articleId,
  articleTitle,
  articleUrl,
  clientKey,
  apiUrl,
  onBack,
}: ArticleViewProps) => {
  const [article, setArticle] = useState<HelpArticleContent | null>(null);
  const [status, setStatus] = useState<ArticleViewStatus>("idle");
  const loadedRef = useRef(false);

  const fetchArticle = async () => {
    if (!clientKey) {
      setStatus("error");
      return;
    }

    try {
      setStatus("loading");

      const response = await fetch(
        `${apiUrl}/help/articles/${encodeURIComponent(articleId)}?client_key=${encodeURIComponent(clientKey)}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.article) {
        setArticle(data.article);
        setStatus("success");
      } else {
        throw new Error(data.error || "Failed to load article");
      }
    } catch (err) {
      console.error("[Widget] Failed to fetch article:", err);
      setStatus("error");
    }
  };

  // Load article on mount
  useEffect(() => {
    if (!loadedRef.current && status === "idle") {
      loadedRef.current = true;
      fetchArticle();
    }
  }, [articleId, clientKey, apiUrl]);

  const handleRetry = () => {
    setStatus("idle");
    loadedRef.current = false;
    fetchArticle();
  };

  const handleOpenInNewTab = () => {
    window.open(articleUrl, "_blank", "noopener,noreferrer");
  };

  // Loading state
  if (status === "loading") {
    return (
      <div className="widget-article-view">
        <div className="widget-article-header">
          <button
            type="button"
            className="widget-article-back"
            onClick={onBack}
            aria-label="Back to articles"
          >
            ← Back
          </button>
          <button
            type="button"
            className="widget-article-external"
            onClick={handleOpenInNewTab}
            aria-label="Open in new tab"
          >
            <ExternalLinkIcon />
          </button>
        </div>
        <div className="widget-article-loading">
          <div className="widget-article-loading-spinner" aria-hidden="true" />
          <span>Loading article...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="widget-article-view">
        <div className="widget-article-header">
          <button
            type="button"
            className="widget-article-back"
            onClick={onBack}
            aria-label="Back to articles"
          >
            ← Back
          </button>
        </div>
        <div className="widget-article-error">
          <div className="widget-article-error-icon" aria-hidden="true">
            ⚠️
          </div>
          <h4 className="widget-article-error-title">Unable to load article</h4>
          <p className="widget-article-error-text">
            We couldn't load this article. Please try again.
          </p>
          <button
            type="button"
            className="widget-article-error-retry"
            onClick={handleRetry}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Success state
  return (
    <div className="widget-article-view">
      <div className="widget-article-header">
        <button
          type="button"
          className="widget-article-back"
          onClick={onBack}
          aria-label="Back to articles"
        >
          ← Back
        </button>
        <button
          type="button"
          className="widget-article-external"
          onClick={handleOpenInNewTab}
          aria-label="Open in new tab"
          title="Open full article in new tab"
        >
          <ExternalLinkIcon />
        </button>
      </div>

      <article className="widget-article-content">
        <h1 className="widget-article-content-title">
          {article?.title || articleTitle}
        </h1>
        {article?.content_html && (
          <div className="widget-article-content-body">
            {renderSafeArticleHtml(article.content_html)}
          </div>
        )}
        {article?.updatedAt && (
          <div className="widget-article-content-meta">
            Last updated: {new Date(article.updatedAt).toLocaleDateString()}
          </div>
        )}
      </article>
    </div>
  );
};
