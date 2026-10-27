import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronRightIcon } from "../assets/icons";

/**
 * Article item for list view (no content)
 */
export interface HelpArticleItem {
  id: string;
  title: string;
  url: string;
}

export type ArticleListStatus = "idle" | "loading" | "error" | "success";

interface ArticleListViewProps {
  collectionId: string;
  collectionTitle: string;
  clientKey: string;
  apiUrl: string;
  onArticleSelect: (article: HelpArticleItem) => void;
  onBack: () => void;
}

/**
 * ArticleListView displays articles within a collection.
 *
 * - Lazy loads articles when mounted
 * - Cursor-based pagination with "Load more"
 * - Opens article in ArticleView on click
 */
export const ArticleListView = ({
  collectionId,
  collectionTitle,
  clientKey,
  apiUrl,
  onArticleSelect,
  onBack,
}: ArticleListViewProps) => {
  const [articles, setArticles] = useState<HelpArticleItem[]>([]);
  const [status, setStatus] = useState<ArticleListStatus>("idle");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadedRef = useRef(false);

  const fetchArticles = async (cursor?: string | null) => {
    if (!clientKey) {
      setStatus("error");
      return;
    }

    try {
      if (!cursor) {
        setStatus("loading");
      } else {
        setIsLoadingMore(true);
      }

      const params = new URLSearchParams({
        client_key: clientKey,
      });
      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(
        `${apiUrl}/help/collections/${encodeURIComponent(collectionId)}/articles?${params}`,
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
      if (data.success && Array.isArray(data.articles)) {
        if (cursor) {
          // Append to existing articles
          setArticles((prev) => [...prev, ...data.articles]);
        } else {
          setArticles(data.articles);
        }
        setNextCursor(data.nextCursor || null);
        setStatus("success");
      } else {
        throw new Error(data.error || "Failed to load articles");
      }
    } catch (err) {
      console.error("[Widget] Failed to fetch articles:", err);
      if (!cursor) {
        setStatus("error");
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Initial load
  useEffect(() => {
    if (!loadedRef.current && status === "idle") {
      loadedRef.current = true;
      fetchArticles();
    }
  }, [collectionId, clientKey, apiUrl]);

  const handleLoadMore = () => {
    if (nextCursor && !isLoadingMore) {
      fetchArticles(nextCursor);
    }
  };

  const handleRetry = () => {
    setStatus("idle");
    loadedRef.current = false;
    fetchArticles();
  };

  // Loading state
  if (status === "loading") {
    return (
      <div className="widget-articles">
        <div className="widget-articles-header">
          <button
            type="button"
            className="widget-articles-back"
            onClick={onBack}
            aria-label="Back to collections"
          >
            ← Back
          </button>
          <h3 className="widget-articles-title">{collectionTitle}</h3>
        </div>
        <div className="widget-articles-loading">
          <div className="widget-articles-loading-spinner" aria-hidden="true" />
          <span>Loading articles...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="widget-articles">
        <div className="widget-articles-header">
          <button
            type="button"
            className="widget-articles-back"
            onClick={onBack}
            aria-label="Back to collections"
          >
            ← Back
          </button>
          <h3 className="widget-articles-title">{collectionTitle}</h3>
        </div>
        <div className="widget-articles-error">
          <div className="widget-articles-error-icon" aria-hidden="true">
            ⚠️
          </div>
          <h4 className="widget-articles-error-title">
            Unable to load articles
          </h4>
          <p className="widget-articles-error-text">
            We couldn't load the articles. Please try again.
          </p>
          <button
            type="button"
            className="widget-articles-error-retry"
            onClick={handleRetry}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (status === "success" && articles.length === 0) {
    return (
      <div className="widget-articles">
        <div className="widget-articles-header">
          <button
            type="button"
            className="widget-articles-back"
            onClick={onBack}
            aria-label="Back to collections"
          >
            ← Back
          </button>
          <h3 className="widget-articles-title">{collectionTitle}</h3>
        </div>
        <div className="widget-articles-empty">
          <div className="widget-articles-empty-icon" aria-hidden="true">
            📄
          </div>
          <h4 className="widget-articles-empty-title">
            No articles in this collection
          </h4>
          <p className="widget-articles-empty-text">
            Articles will appear here once they're published.
          </p>
        </div>
      </div>
    );
  }

  // Success state with articles
  return (
    <div className="widget-articles">
      <div className="widget-articles-header">
        <button
          type="button"
          className="widget-articles-back"
          onClick={onBack}
          aria-label="Back to collections"
        >
          ← Back
        </button>
        <h3 className="widget-articles-title">{collectionTitle}</h3>
      </div>

      <div className="widget-articles-list">
        {articles.map((article) => (
          <button
            key={article.id}
            type="button"
            className="widget-article-item"
            onClick={() => onArticleSelect(article)}
          >
            <span className="widget-article-item-title">{article.title}</span>
            <span className="widget-article-item-arrow" aria-hidden="true">
              <ChevronRightIcon />
            </span>
          </button>
        ))}
      </div>

      {nextCursor && (
        <div className="widget-articles-pagination">
          <button
            type="button"
            className="widget-articles-load-more"
            onClick={handleLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
};
