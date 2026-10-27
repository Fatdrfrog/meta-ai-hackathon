import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import https, { type RequestOptions } from "node:https";
import net from "node:net";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  isDisallowedLocalHostname,
  isPrivateOrReservedIp,
} from "@icecore/shared/lib/network-safety";

export const MAX_GENERATED_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/octet-stream",
]);

export type ProviderDownloadPolicy =
  | { kind: "stable"; hostnames: string[] }
  | { kind: "dynamic" };

type ResolvedAddress = { address: string; family: number };
type ResponseLike = Readable & {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
};
type RequestLike = {
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(error?: Error): unknown;
  end(): unknown;
  setTimeout?(timeoutMs: number, listener: () => void): unknown;
};
type RequestFn = (
  options: RequestOptions,
  handler: (response: ResponseLike) => void,
) => RequestLike;

function normalizedHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function matches(hostname: string, pattern: string): boolean {
  const host = normalizedHost(hostname);
  const expected = normalizedHost(pattern);
  if (expected.startsWith("*.")) {
    const suffix = expected.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === expected;
}

export function validateProviderDownloadUrl(
  rawUrl: string,
  policy: ProviderDownloadPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider result URL is invalid");
  }
  if (url.protocol !== "https:")
    throw new Error("Provider result URL must use HTTPS");
  if (isDisallowedLocalHostname(url.hostname))
    throw new Error(
      "Provider result URL cannot target a private or local host",
    );
  if (
    policy.kind === "stable" &&
    !policy.hostnames.some((pattern) => matches(url.hostname, pattern))
  ) {
    throw new Error(`Provider result URL host is not allowed: ${url.hostname}`);
  }
  return url;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function initialRequestHeaders(params: {
  url: URL;
  authorization?: string;
  requestHeaders?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  let explicitAuthorization: string | undefined;
  for (const [name, value] of Object.entries(params.requestHeaders ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (
      !normalized ||
      normalized === "host" ||
      normalized === "connection" ||
      normalized === "content-length" ||
      normalized === "transfer-encoding"
    ) {
      continue;
    }
    if (normalized === "authorization") {
      explicitAuthorization = value;
      continue;
    }
    headers[name] = value;
  }
  const authorization = params.authorization ?? explicitAuthorization;
  if (authorization) headers.Authorization = authorization;
  headers.Host = params.url.host;
  return headers;
}

function requestOnce(params: {
  url: URL;
  address: ResolvedAddress;
  authorization?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs: number;
  request: RequestFn;
}): Promise<ResponseLike> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socketHostname = normalizedHost(params.url.hostname);
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        callback();
      }
    };
    const request = params.request(
      {
        protocol: "https:",
        hostname: socketHostname,
        port: params.url.port || 443,
        path: `${params.url.pathname}${params.url.search}`,
        method: "GET",
        agent: false,
        ...(net.isIP(socketHostname) ? {} : { servername: socketHostname }),
        headers: initialRequestHeaders(params),
        lookup: (_hostname, options, callback) => {
          const address = {
            address: params.address.address,
            family: params.address.family as 4 | 6,
          };
          if (typeof options === "object" && options.all) {
            (
              callback as (
                error: NodeJS.ErrnoException | null,
                addresses: (typeof address)[],
              ) => void
            )(null, [address]);
            return;
          }
          (
            callback as (
              error: NodeJS.ErrnoException | null,
              address: string,
              family: 4 | 6,
            ) => void
          )(null, address.address, address.family);
        },
        signal: params.signal,
      },
      (response) => finish(() => resolve(response)),
    );
    request.on("error", (error) => finish(() => reject(error)));
    request.setTimeout?.(params.timeoutMs, () =>
      request.destroy(new Error("Provider video download timed out")),
    );
    request.end();
  });
}

async function publicAddress(
  hostname: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname))
      throw new Error(
        "Provider result resolved to a private or reserved address",
      );
    return { address: hostname, family: net.isIP(hostname) };
  }
  const addresses = await new Promise<ResolvedAddress[]>(
    (resolveValue, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () =>
        finish(() =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Provider video download was cancelled"),
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      resolve(hostname).then(
        (value) => finish(() => resolveValue(value)),
        (error) => finish(() => reject(error)),
      );
    },
  );
  if (!addresses.length)
    throw new Error("Provider result hostname did not resolve");
  for (const item of addresses) {
    if (isPrivateOrReservedIp(item.address))
      throw new Error(
        "Provider result resolved to a private or reserved address",
      );
  }
  return addresses[0]!;
}

export async function downloadProviderVideoToFile(params: {
  url: string;
  destinationPath: string;
  policy: ProviderDownloadPolicy;
  authorization?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  allowedMimeTypes?: ReadonlySet<string>;
  deps?: {
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    request?: RequestFn;
  };
}): Promise<{ fileSize: number; sha256: string; mimeType: string }> {
  const resolve =
    params.deps?.resolve ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const request =
    params.deps?.request ?? (https.request as unknown as RequestFn);
  const maxBytes = params.maxBytes ?? MAX_GENERATED_VIDEO_BYTES;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () =>
    controller.abort(
      params.signal?.reason instanceof Error
        ? params.signal.reason
        : new Error("Provider video download was cancelled"),
    );
  params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (params.signal?.aborted) abortFromCaller();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Provider video download timed out"));
  }, timeoutMs);
  let currentUrl = params.url;
  let authorization = params.authorization;
  let requestHeaders = params.requestHeaders;
  let destinationCreated = false;

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const url = validateProviderDownloadUrl(currentUrl, params.policy);
      const address = await publicAddress(
        normalizedHost(url.hostname),
        resolve,
        controller.signal,
      );
      const response = await requestOnce({
        url,
        address,
        authorization,
        requestHeaders,
        signal: controller.signal,
        timeoutMs,
        request,
      });
      const status = response.statusCode ?? 0;
      const location = firstHeader(response.headers.location);
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        if (redirects === MAX_REDIRECTS)
          throw new Error("Provider result URL has too many redirects");
        currentUrl = new URL(location, url).toString();
        authorization = undefined;
        requestHeaders = undefined;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new Error(`Provider video download failed with HTTP ${status}`);
      }

      const mimeType = firstHeader(response.headers["content-type"])
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (
        !(params.allowedMimeTypes ?? ALLOWED_VIDEO_MIME_TYPES).has(mimeType)
      ) {
        response.destroy();
        throw new Error(
          `Provider video content type is not allowed: ${mimeType || "missing"}`,
        );
      }
      const declaredLength = Number(
        firstHeader(response.headers["content-length"]),
      );
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        throw new Error("Provider video exceeds the 50 MiB size limit");
      }

      let fileSize = 0;
      const hash = createHash("sha256");
      let prefix = Buffer.alloc(0);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileSize += chunk.byteLength;
          if (fileSize > maxBytes)
            return callback(
              new Error("Provider video exceeds the 50 MiB size limit"),
            );
          if (prefix.byteLength < 512) {
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, 512 - prefix.byteLength),
            ]);
            const sniffed = prefix.toString("utf8").trimStart().toLowerCase();
            if (
              sniffed.startsWith("<!doctype html") ||
              sniffed.startsWith("<html")
            ) {
              return callback(
                new Error("Provider video response contains HTML"),
              );
            }
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const destination = createWriteStream(params.destinationPath, {
        flags: "wx",
      });
      destination.once("open", () => {
        destinationCreated = true;
      });
      await pipeline(response, meter, destination, {
        signal: controller.signal,
      });
      if (fileSize === 0) throw new Error("Provider video response is empty");
      return { fileSize, sha256: hash.digest("hex"), mimeType };
    }
    throw new Error("Provider result URL has too many redirects");
  } catch (error) {
    if (destinationCreated) {
      await unlink(params.destinationPath).catch(() => undefined);
    }
    if (timedOut) throw new Error("Provider video download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
  }
}
