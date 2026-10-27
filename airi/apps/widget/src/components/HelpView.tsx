import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ArticlesIcon,
  ChevronRightIcon,
  PageIcon,
  SearchIcon,
} from "../assets/icons";

/** Debounce delay for search input in milliseconds */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Help collection from the KB API
 */
export interface HelpCollection {
  id: string;
  title: string;
  description: string | null;
  articleCount: number;
  /** Full public URL to the KB article (built by backend) */
  url: string;
}

/**
 * Search result from the widget help search API
 */
export interface HelpSearchResult {
  id: string;
  title: string;
  url: string;
}

export type HelpViewStatus = "idle" | "loading" | "error" | "success";

interface HelpViewProps {
  collections: HelpCollection[];
  status: HelpViewStatus;
  onRetry?: () => void;
  /** Called when user clicks a collection (Phase 2: navigate to article list) */
  onCollectionSelect?: (collection: HelpCollection) => void;
  /** Called when user clicks a leaf article (articleCount === 0) — opens directly in reader */
  onArticleSelect?: (collection: HelpCollection) => void;
  /** Client key for API calls */
  clientKey?: string;
  /** API URL base for widget endpoints */
  apiUrl?: string;
}

/**
 * HelpView displays KB collections in the widget Help tab.
 *
 * - Collections are passed from parent (WidgetWindow) after lazy-loading from API
 * - Search queries the server-side KB search endpoint for publicly accessible articles
 * - On click, opens the collection's public KB URL in a new tab
 * - Shows loading/error/empty states as appropriate
 */
export const HelpView = ({
  collections,
  status,
  onRetry,
  onCollectionSelect,
  onArticleSelect,
  clientKey,
  apiUrl = "https://www.airi.chat/api/widget",
}: HelpViewProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HelpSearchResult[]>([]);
  const [searchError, setSearchError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const performSearch = useCallback(
    async (query: string) => {
      if (!clientKey || query.length < 2) {
        setSearchResults([]);
        setSearchError(false);
        setIsSearching(false);
        return;
      }

      // Abort any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearchResults([]);
      setSearchError(false);
      setIsSearching(true);
      try {
        const params = new URLSearchParams({
          client_key: clientKey,
          q: query,
        });
        const response = await fetch(`${apiUrl}/help/search?${params}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data.success && Array.isArray(data.results)) {
          setSearchResults(data.results);
          setSearchError(false);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[Widget] Help search failed:", err);
          setSearchError(true);
          setSearchResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    },
    [clientKey, apiUrl],
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      const trimmed = value.trim();
      if (trimmed.length < 2) {
        setSearchResults([]);
        setSearchError(false);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      debounceRef.current = setTimeout(() => {
        performSearch(trimmed);
      }, SEARCH_DEBOUNCE_MS);
    },
    [performSearch],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const isActiveSearch = searchQuery.trim().length >= 2;
  const filteredCollections = isActiveSearch ? [] : collections;

  /**
   * Handle collection/article click:
   * - Leaf articles (articleCount === 0): open directly in expanded ArticleView
   * - Collections (articleCount > 0): navigate to article list
   * - Fallback: open URL in new tab
   */
  const handleCollectionClick = (collection: HelpCollection) => {
    if (collection.articleCount === 0 && onArticleSelect) {
      // Leaf article — skip article list, open directly in reader
      onArticleSelect(collection);
    } else if (onCollectionSelect) {
      onCollectionSelect(collection);
    } else {
      // Phase 1 fallback: open in new tab
      window.open(collection.url, "_blank", "noopener,noreferrer");
    }
  };

  // Loading state
  if (status === "loading") {
    return (
      <div className="widget-help">
        <div className="widget-help-loading">
          <div className="widget-help-loading-spinner" aria-hidden="true" />
          <span>Loading help articles...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="widget-help">
        <div className="widget-help-error">
          <div className="widget-help-error-icon" aria-hidden="true">
            ⚠️
          </div>
          <h3 className="widget-help-error-title">Unable to load help</h3>
          <p className="widget-help-error-text">
            We couldn't load the help articles. Please try again.
          </p>
          {onRetry && (
            <button
              type="button"
              className="widget-help-error-retry"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // Empty state (success but no collections)
  if (status === "success" && collections.length === 0) {
    return (
      <div className="widget-help">
        <div className="widget-help-empty">
          <div className="widget-help-empty-icon" aria-hidden="true">
            📚
          </div>
          <h3 className="widget-help-empty-title">
            No help articles available
          </h3>
          <p className="widget-help-empty-text">
            Help articles will appear here once they're published.
          </p>
        </div>
      </div>
    );
  }

  /**
   * Handle search result click: open directly in article reader
   */
  const handleSearchResultClick = (result: HelpSearchResult) => {
    if (onArticleSelect) {
      onArticleSelect({
        id: result.id,
        title: result.title,
        description: null,
        articleCount: 0,
        url: result.url,
      });
    } else {
      window.open(result.url, "_blank", "noopener,noreferrer");
    }
  };

  // Success state with collections
  return (
    <div className="widget-help">
      <div className="widget-help-search">
        <input
          type="search"
          className="widget-help-search-input"
          placeholder="Search articles..."
          value={searchQuery}
          onInput={(e) =>
            handleSearchInput((e.target as HTMLInputElement).value)
          }
          aria-label="Search help articles"
        />
        <span className="widget-help-search-icon" aria-hidden="true">
          <SearchIcon />
        </span>
      </div>

      {isActiveSearch ? (
        <div className="widget-help-collections">
          {isSearching ? (
            <div className="widget-help-loading">
              <div className="widget-help-loading-spinner" aria-hidden="true" />
              <span>Searching...</span>
            </div>
          ) : searchError ? (
            <div className="widget-help-error">
              <h3 className="widget-help-error-title">Search failed</h3>
              <p className="widget-help-error-text">
                We couldn't search help articles. Please try again.
              </p>
              <button
                type="button"
                className="widget-help-error-retry"
                onClick={() => performSearch(searchQuery.trim())}
              >
                Try again
              </button>
            </div>
          ) : searchResults.length > 0 ? (
            <>
              <h3 className="widget-help-collections-title">
                {searchResults.length} result
                {searchResults.length !== 1 ? "s" : ""}
              </h3>
              <div className="widget-help-collections-list">
                {searchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    className="widget-help-collection-card"
                    onClick={() => handleSearchResultClick(result)}
                  >
                    <div className="widget-help-collection-content">
                      <div className="widget-help-collection-title">
                        {result.title}
                      </div>
                      <div className="widget-help-collection-meta">
                        <PageIcon />
                        <span className="widget-help-collection-type">
                          Article
                        </span>
                      </div>
                    </div>
                    <span
                      className="widget-help-collection-arrow"
                      aria-hidden="true"
                    >
                      <ChevronRightIcon />
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="widget-help-empty">
              <h3 className="widget-help-empty-title">No results found</h3>
              <p className="widget-help-empty-text">
                Try a different search term.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="widget-help-collections">
          <h3 className="widget-help-collections-title">
            {filteredCollections.length} result
            {filteredCollections.length !== 1 ? "s" : ""}
          </h3>
          <div className="widget-help-collections-list">
            {filteredCollections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className="widget-help-collection-card"
                onClick={() => handleCollectionClick(collection)}
              >
                <div className="widget-help-collection-content">
                  <div className="widget-help-collection-title">
                    {collection.title}
                  </div>
                  {collection.description && (
                    <div className="widget-help-collection-description">
                      {collection.description}
                    </div>
                  )}
                  <div className="widget-help-collection-meta">
                    {collection.articleCount > 0 ? (
                      <>
                        <ArticlesIcon />
                        <span>
                          {collection.articleCount} Article
                          {collection.articleCount !== 1 ? "s" : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        <PageIcon />
                        <span className="widget-help-collection-type">
                          Article
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <span
                  className="widget-help-collection-arrow"
                  aria-hidden="true"
                >
                  <ChevronRightIcon />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
