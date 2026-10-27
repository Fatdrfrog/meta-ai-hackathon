const META_GRAPH_API_VERSION = "v25.0";
export const META_GRAPH_ORIGIN = "https://graph.facebook.com";
export const META_GRAPH_BASE_URL = `${META_GRAPH_ORIGIN}/${META_GRAPH_API_VERSION}`;
export const META_INSTAGRAM_GRAPH_BASE_URL = `https://graph.instagram.com/${META_GRAPH_API_VERSION}`;

export function resolveInstagramGraphBase(authMethod?: string): string {
  return authMethod === "instagram_business_login"
    ? META_INSTAGRAM_GRAPH_BASE_URL
    : META_GRAPH_BASE_URL;
}

export function resolveInstagramGraphBaseCandidates(
  authMethod?: string,
): string[] {
  return authMethod === "instagram_business_login"
    ? [META_INSTAGRAM_GRAPH_BASE_URL, META_GRAPH_BASE_URL]
    : [META_GRAPH_BASE_URL, META_INSTAGRAM_GRAPH_BASE_URL];
}

export function buildGraphApiUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  return `${META_GRAPH_BASE_URL}/${normalizedPath}`;
}
