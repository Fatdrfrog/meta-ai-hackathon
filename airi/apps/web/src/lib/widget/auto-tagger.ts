/**
 * Automatic Tagging for Web Widget Conversations
 *
 * Automatically assigns tags based on URL patterns to help categorize conversations.
 *
 * Integration with Taxonomy System:
 * - Uses hardcoded rules as fallback
 * - Can be enhanced to use workspace-specific taxonomy from Supabase
 * - TODO: Fetch taxonomy rules from database when available
 */

import { readLatestTaxonomy } from "@/lib/classifier/taxonomy-server";
import { escapeRegExp } from "@/lib/regex-utils";

interface TagRule {
  pattern: RegExp;
  tags: string[];
}

// Fallback tagging rules (used when no taxonomy configured)
// These provide sensible defaults for common e-commerce/SaaS patterns
const FALLBACK_TAG_RULES: TagRule[] = [
  // Product pages
  { pattern: /\/product/i, tags: ["product-inquiry", "sales"] },
  { pattern: /\/pricing/i, tags: ["pricing", "sales"] },
  { pattern: /\/plans/i, tags: ["pricing", "subscription"] },

  // Support pages
  { pattern: /\/help/i, tags: ["help", "support"] },
  { pattern: /\/support/i, tags: ["support"] },
  { pattern: /\/faq/i, tags: ["help", "faq"] },
  { pattern: /\/docs/i, tags: ["documentation", "help"] },

  // Account pages
  { pattern: /\/account/i, tags: ["account"] },
  { pattern: /\/profile/i, tags: ["account", "profile"] },
  { pattern: /\/settings/i, tags: ["account", "settings"] },
  { pattern: /\/billing/i, tags: ["billing", "payment"] },

  // Shopping pages
  { pattern: /\/cart/i, tags: ["cart", "checkout"] },
  { pattern: /\/checkout/i, tags: ["checkout", "purchase"] },
  { pattern: /\/order/i, tags: ["order", "purchase"] },

  // Content pages
  { pattern: /\/blog/i, tags: ["blog", "content"] },
  { pattern: /\/news/i, tags: ["news", "content"] },
  { pattern: /\/article/i, tags: ["content"] },

  // Company pages
  { pattern: /\/about/i, tags: ["company-info"] },
  { pattern: /\/contact/i, tags: ["contact", "inquiry"] },
  { pattern: /\/careers/i, tags: ["careers", "hiring"] },

  // Dashboard/Panel
  { pattern: /\/dashboard/i, tags: ["dashboard", "user-area"] },
  { pattern: /\/panel/i, tags: ["panel", "user-area"] },
  { pattern: /\/admin/i, tags: ["admin"] },
];

/**
 * Fetch taxonomy-based tagging rules for a workspace (if configured)
 * Falls back to hardcoded rules if no taxonomy exists
 */
async function getTaggingRules(workspaceId?: string): Promise<TagRule[]> {
  if (!workspaceId) {
    return FALLBACK_TAG_RULES;
  }

  try {
    // Widget visitors have no Airi session, so read the taxonomy on the server
    // for the workspace of the already-authorized widget source. A workspace
    // can hold several rows; the classifier's reader picks the current one.
    const { data: taxonomy } = await readLatestTaxonomy(workspaceId);

    if (taxonomy && Array.isArray(taxonomy.labels)) {
      // Labels are tenant text matched literally against the visitor's URL:
      // they are escaped, so a label never runs as a regular expression.
      const dynamicRules: TagRule[] = taxonomy.labels.flatMap(label => {
        const tag = typeof label === "string" ? label.trim().toLowerCase() : "";
        return tag
          ? [{ pattern: new RegExp(escapeRegExp(tag), "i"), tags: [tag] }]
          : [];
      });

      return [...dynamicRules, ...FALLBACK_TAG_RULES];
    }
  } catch (error) {
    console.warn(
      "[Auto-tagger] Failed to fetch taxonomy, using fallback rules:",
      error
    );
  }

  return FALLBACK_TAG_RULES;
}

/**
 * Generate tags for a URL
 * Integrates with workspace taxonomy when available
 */
export async function generateTagsFromUrl(
  url: string,
  workspaceId?: string
): Promise<string[]> {
  const tags = new Set<string>();
  const rules = await getTaggingRules(workspaceId);

  for (const rule of rules) {
    if (rule.pattern.test(url)) {
      rule.tags.forEach(tag => tags.add(tag));
    }
  }

  return Array.from(tags);
}

/**
 * Generate priority based on URL patterns
 */
export function inferPriorityFromUrl(
  url: string
): "low" | "medium" | "high" | "urgent" | null {
  // High priority pages
  if (/\/(checkout|payment|billing|error|problem)/i.test(url)) {
    return "high";
  }

  // Medium priority pages
  if (/\/(cart|pricing|order|support)/i.test(url)) {
    return "medium";
  }

  // Low priority pages
  if (/\/(blog|about|careers|news)/i.test(url)) {
    return "low";
  }

  // Default - let AI classify
  return null;
}

/**
 * Suggest category based on URL patterns
 */
export function suggestCategoryFromUrl(url: string): string | null {
  if (/\/(pricing|plans|billing|payment|checkout)/i.test(url)) {
    return "Sales";
  }

  if (/\/(help|support|faq|docs)/i.test(url)) {
    return "Support";
  }

  if (/\/(account|profile|settings)/i.test(url)) {
    return "Account";
  }

  if (/\/(cart|order|product)/i.test(url)) {
    return "Sales";
  }

  // Default - let AI classify
  return null;
}
