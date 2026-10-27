import "server-only";

import { lookup } from "node:dns/promises";

import {
  isDisallowedCrawlHost,
  isPrivateOrReservedIp,
} from "@/lib/crawler/crawl-html-utils";

/**
 * Raised when a crawl target resolves to a disallowed (private/reserved) host.
 * The crawler treats these as a skipped page rather than a hard failure.
 */
export class CrawlSsrfError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "protocol"
      | "disallowed_host"
      | "dns_failed"
      | "private_ip"
      | "too_many_redirects"
  ) {
    super(message);
    this.name = "CrawlSsrfError";
  }
}

const MAX_REDIRECTS = 4;

/**
 * Resolves a hostname and throws unless every resolved address is a public
 * (non-private/reserved) IP. Also rejects literal localhost/.local/private hosts
 * before touching DNS.
 */
async function assertHostResolvesPublic(
  hostname: string,
  timeoutMs: number
): Promise<void> {
  if (isDisallowedCrawlHost(hostname)) {
    throw new CrawlSsrfError(
      `Host is not allowed: ${hostname}`,
      "disallowed_host"
    );
  }

  let addresses: Array<{ address: string }>;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new CrawlSsrfError(
                `DNS lookup timed out: ${hostname}`,
                "dns_failed"
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof CrawlSsrfError) throw error;
    throw new CrawlSsrfError(`DNS lookup failed: ${hostname}`, "dns_failed");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (addresses.length === 0) {
    throw new CrawlSsrfError(`No DNS records: ${hostname}`, "dns_failed");
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new CrawlSsrfError(
        `Host resolves to a private/reserved IP: ${hostname} -> ${address}`,
        "private_ip"
      );
    }
  }
}

export type SafeCrawlFetchOptions = {
  timeoutMs: number;
  userAgent: string;
  maxRedirects?: number;
  dnsTimeoutMs?: number;
  /**
   * Caller-owned deadline. `timeoutMs` only covers each hop until its headers
   * arrive; this signal stays on the returned response, so aborting it also
   * cancels a body read that is still in progress.
   */
  signal?: AbortSignal;
};

/**
 * SSRF-hardened fetch for crawler use:
 * - allows only http/https
 * - validates the host (literal + DNS-resolved IPs) before every request
 * - follows redirects manually, re-validating each hop's host
 *
 * Note: a determined attacker could still attempt DNS rebinding between the
 * lookup and the socket connect (TOCTOU). Eliminating that requires pinning the
 * validated IP at the socket layer (custom agent), which is out of scope here;
 * this mitigation covers the requested literal + resolved-IP + redirect checks.
 */
export async function safeCrawlFetch(
  rawUrl: string,
  options: SafeCrawlFetchOptions
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 2500;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlSsrfError(`Invalid URL: ${rawUrl}`, "protocol");
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CrawlSsrfError(
        `Disallowed protocol: ${url.protocol}`,
        "protocol"
      );
    }

    options.signal?.throwIfAborted();
    await assertHostResolvesPublic(url.hostname, dnsTimeoutMs);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
        redirect: "manual",
        headers: { "User-Agent": options.userAgent },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    try {
      url = new URL(location, url);
    } catch {
      throw new CrawlSsrfError(
        `Invalid redirect target: ${location}`,
        "protocol"
      );
    }
  }

  throw new CrawlSsrfError("Too many redirects", "too_many_redirects");
}
