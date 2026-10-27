export type FewShotExample = { text: string; label: string };

export type WorkspaceTaxonomy = {
  id: string;
  workspaceId: string;
  vertical?: string;
  labels: string[];
  guidelines?: string;
  fewShots?: FewShotExample[];
  confidenceThreshold?: number; // e.g., 0.7
  version?: string; // taxonomy version string
};

const OTHER_LABEL = "Other";

function truncateTaxonomyExample(text: string, maxLength = 120): string {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

const DEFAULT_FEW_SHOTS: FewShotExample[] = [
  {
    text: "How much is the pro plan per month and can I book a demo before buying?",
    label: "Sales",
  },
  {
    text: "Do you offer annual pricing and discounts for multiple seats?",
    label: "Sales",
  },
  {
    text: "My order #A1234 still has not arrived. Can you track the shipment for me?",
    label: "Support",
  },
  {
    text: "I cannot log in after resetting my password. Please help me access my account.",
    label: "Support",
  },
  {
    text: "I want a refund. The product arrived damaged and I am very disappointed.",
    label: "Complaint",
  },
  {
    text: "Your service has been down for hours and nobody is helping. This is unacceptable.",
    label: "Complaint",
  },
  {
    text: "What are your business hours and where are you located?",
    label: "General inquiry",
  },
  {
    text: "Do you have a return policy for unopened items?",
    label: "General inquiry",
  },
  {
    text: "Visit my crypto site for easy money and guaranteed traffic growth!!!",
    label: "Spam",
  },
  {
    text: "We do SEO, web design, and lead generation. Reply to partner with us.",
    label: "Spam",
  },
];

export const DEFAULT_TAXONOMY: WorkspaceTaxonomy = {
  id: "default",
  workspaceId: "default",
  labels: ["Sales", "Support", "Complaint", "General inquiry", "Spam", "Other"],
  guidelines:
    "Use discrete, mutually exclusive categories tied to the customer's dominant current business intent or lifecycle state. Prefer the most actionable label for segmentation. Use Complaint when strong dissatisfaction, refund/cancellation pressure, or escalation risk dominates the conversation. Use Support for help on an existing order, account, setup, delivery, or product problem. Use Sales for pre-purchase pricing, demo, quote, plan-selection, or buying intent. Use General inquiry only for neutral informational questions with no active issue or buying motion. Use Spam for irrelevant solicitation, phishing, or non-customer outreach. Use Other only when none of the labels clearly fit.",
  fewShots: DEFAULT_FEW_SHOTS,
  confidenceThreshold: 0.7,
  version: "v2-default",
};

export function normalizeTaxonomyLabels(
  labels: string[] | undefined | null
): string[] {
  const cleaned = (labels || [])
    .map(label => String(label).trim())
    .filter(label => label.length > 0);
  const unique = Array.from(new Set(cleaned));
  if (
    !unique.some(label => label.toLowerCase() === OTHER_LABEL.toLowerCase())
  ) {
    unique.push(OTHER_LABEL);
  }
  return unique;
}

export function normalizeFewShotExamples(
  fewShots: FewShotExample[] | undefined | null,
  labels: string[] | undefined | null
): FewShotExample[] {
  const allowedLabels = normalizeTaxonomyLabels(labels);
  const allowedLabelMap = new Map(
    allowedLabels.map(label => [label.toLowerCase(), label])
  );
  const deduped = new Set<string>();
  const normalized: FewShotExample[] = [];

  for (const example of fewShots || []) {
    const text = String(example?.text || "")
      .replace(/\s+/g, " ")
      .trim();
    const label = allowedLabelMap.get(
      String(example?.label || "")
        .trim()
        .toLowerCase()
    );
    if (!text || !label) continue;

    const dedupeKey = `${label.toLowerCase()}::${text.toLowerCase()}`;
    if (deduped.has(dedupeKey)) continue;
    deduped.add(dedupeKey);
    normalized.push({
      text,
      label,
    });
  }

  return normalized.slice(0, 24);
}

export function backfillFewShotCoverage(
  labels: string[],
  fewShots: FewShotExample[]
): FewShotExample[] {
  const normalizedLabels = normalizeTaxonomyLabels(labels);
  const current = normalizeFewShotExamples(fewShots, normalizedLabels);
  const coverage = new Set(current.map(example => example.label.toLowerCase()));
  const defaultCandidates = normalizeFewShotExamples(
    DEFAULT_FEW_SHOTS,
    normalizedLabels
  );

  for (const label of normalizedLabels) {
    if (label.toLowerCase() === OTHER_LABEL.toLowerCase()) continue;
    if (coverage.has(label.toLowerCase())) continue;

    const fallbackExamples = defaultCandidates
      .filter(example => example.label.toLowerCase() === label.toLowerCase())
      .slice(0, 2);

    if (fallbackExamples.length > 0) {
      current.push(...fallbackExamples);
      coverage.add(label.toLowerCase());
    }
  }

  return current.slice(0, 24);
}

function hasLabel(labels: string[], candidate: string): boolean {
  return labels.some(label => label.toLowerCase() === candidate.toLowerCase());
}

export function buildTaxonomyDecisionGuide(
  taxonomy: Pick<WorkspaceTaxonomy, "labels" | "guidelines" | "fewShots">
): string {
  const labels = normalizeTaxonomyLabels(taxonomy.labels);
  const fewShots = backfillFewShotCoverage(
    labels,
    normalizeFewShotExamples(taxonomy.fewShots, labels)
  );
  const grouped = new Map<string, FewShotExample[]>();

  for (const label of labels) {
    grouped.set(
      label,
      fewShots.filter(
        example => example.label.toLowerCase() === label.toLowerCase()
      )
    );
  }

  const sections: string[] = [];
  if (String(taxonomy.guidelines || "").trim()) {
    sections.push(`Core rules: ${String(taxonomy.guidelines).trim()}`);
  }

  sections.push("Label anchors:");
  for (const label of labels) {
    const examples = (grouped.get(label) || []).slice(0, 2);
    if (examples.length > 0) {
      sections.push(
        `- ${label}: choose when the conversation is similar to ${examples
          .map(example => `"${truncateTaxonomyExample(example.text)}"`)
          .join(" or ")}.`
      );
    } else {
      sections.push(
        `- ${label}: choose only when the conversation clearly fits this label better than the others.`
      );
    }
  }

  const disambiguationRules = [
    "- Choose the single best current segmentation label, not every topic mentioned in the conversation.",
    "- Prioritize the latest customer state and the business action the team should take next.",
  ];

  if (hasLabel(labels, "Complaint") && hasLabel(labels, "Support")) {
    disambiguationRules.push(
      "- If the customer needs help but anger, refund pressure, or escalation risk dominates, prefer Complaint over Support."
    );
  }

  if (hasLabel(labels, "Sales")) {
    disambiguationRules.push(
      "- Use Sales for pre-purchase pricing, demo, quote, plan comparison, availability, or buying-intent conversations."
    );
  }

  if (hasLabel(labels, "Support")) {
    disambiguationRules.push(
      "- Use Support for existing-order, account, setup, delivery, troubleshooting, or product-usage help."
    );
  }

  if (hasLabel(labels, "General inquiry")) {
    disambiguationRules.push(
      "- Use General inquiry for neutral informational questions that are not active support issues and not buying intent."
    );
  }

  if (hasLabel(labels, "Spam")) {
    disambiguationRules.push(
      "- Use Spam for irrelevant promotions, phishing, unsolicited outreach, or obvious non-customer traffic."
    );
  }

  if (hasLabel(labels, OTHER_LABEL)) {
    disambiguationRules.push(
      "- Use Other only when none of the available labels clearly fit after applying the rules above."
    );
  }

  sections.push("Disambiguation:");
  sections.push(...disambiguationRules);

  return sections.join("\n");
}
