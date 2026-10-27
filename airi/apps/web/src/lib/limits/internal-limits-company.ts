type InternalCompanyCandidate = {
  name?: string | null;
  slug?: string | null;
};

const INTERNAL_LIMITS_COMPANY_SLUGS = new Set(["airichat"]);
const INTERNAL_LIMITS_COMPANY_NAMES = new Set(["airi.chat"]);

function normalizeCompanyIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isInternalLimitsCompany(
  company: InternalCompanyCandidate | null | undefined
): boolean {
  const slug = normalizeCompanyIdentifier(company?.slug);
  const name = normalizeCompanyIdentifier(company?.name);
  return (
    INTERNAL_LIMITS_COMPANY_SLUGS.has(slug) ||
    INTERNAL_LIMITS_COMPANY_NAMES.has(name)
  );
}
