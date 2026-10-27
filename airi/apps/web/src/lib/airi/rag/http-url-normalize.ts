export function normalizeHttpUrlForRag(url: string): string {
  return url
    .trim()
    .replace(/[),.;:!?]+$/, "")
    .replace(/\/+$/, "");
}

export function isHttpOrHttpsUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
