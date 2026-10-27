import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  isDisallowedLocalHostname,
  isPrivateOrReservedIp,
} from "@icecore/shared/lib/network-safety";
import {
  decryptString,
  encryptString,
  type EncryptedString,
} from "@icecore/shared/lib/encryption";

const ENCRYPTED_SECRET_PREFIX = "enc:v1:";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class CustomerWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerWebhookUrlError";
  }
}

function parseWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CustomerWebhookUrlError("Enter a valid HTTPS webhook URL");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new CustomerWebhookUrlError(
      "Webhook URLs must use HTTPS on port 443"
    );
  }
  if (url.username || url.password || url.hash) {
    throw new CustomerWebhookUrlError(
      "Webhook URLs cannot contain credentials or fragments"
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    isDisallowedLocalHostname(hostname) ||
    (isIP(hostname) && isPrivateOrReservedIp(hostname))
  ) {
    throw new CustomerWebhookUrlError("Webhook URLs must use a public host");
  }
  return url;
}

async function resolvePublicHost(hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CustomerWebhookUrlError("Webhook host lookup timed out")
            ),
          2500
        );
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(({ address }) => isPrivateOrReservedIp(address))
    ) {
      throw new CustomerWebhookUrlError(
        "Webhook URLs must resolve only to public addresses"
      );
    }
    return addresses;
  } catch (error) {
    if (error instanceof CustomerWebhookUrlError) throw error;
    throw new CustomerWebhookUrlError("Webhook host could not be resolved");
  } finally {
    clearTimeout(timer);
  }
}

export async function validateCustomerWebhookUrl(
  rawUrl: string
): Promise<string> {
  const url = parseWebhookUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(hostname)) await resolvePublicHost(hostname);
  return url.toString();
}

export function encryptCustomerWebhookSecret(secret: string): string {
  return `${ENCRYPTED_SECRET_PREFIX}${JSON.stringify(encryptString(secret))}`;
}

export function decryptCustomerWebhookSecret(storedSecret: string): string {
  if (!storedSecret.startsWith("enc:")) return storedSecret;
  if (!storedSecret.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    throw new Error("Unsupported webhook signing secret version");
  }
  return decryptString(
    JSON.parse(
      storedSecret.slice(ENCRYPTED_SECRET_PREFIX.length)
    ) as EncryptedString
  );
}

/** Validate and pin DNS at socket creation so an endpoint cannot rebind to a private IP. */
export async function safeCustomerWebhookFetch(
  rawUrl: string,
  init: RequestInit
): Promise<Response> {
  const url = parseWebhookUrl(rawUrl);
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    resolvePublicHost(hostname).then(
      addresses => {
        const requestedFamily = options.family;
        const family =
          requestedFamily === "IPv4"
            ? 4
            : requestedFamily === "IPv6"
              ? 6
              : requestedFamily;
        const candidates = family
          ? addresses.filter(address => address.family === family)
          : addresses;
        if (!candidates.length) {
          callback(
            new CustomerWebhookUrlError(
              "Webhook host has no usable public address"
            ),
            "",
            0
          );
          return;
        }
        if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      },
      error => callback(error, "", 0)
    );
  };

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method || "POST",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        lookup: safeLookup,
        signal: init.signal ?? undefined,
        // Each delivery resolves its own DNS; pooled sockets must not bypass validation.
        agent: false,
      },
      response => {
        const status = response.statusCode || 502;
        if (status < 200 || status > 599) {
          response.destroy();
          req.destroy(new Error("Webhook returned an invalid HTTP status"));
          return;
        }
        if (status >= 300 && status < 400) {
          response.destroy();
          req.destroy(new Error("Webhook redirects are not allowed"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy();
            req.destroy(new Error("Webhook response exceeded 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", error => {
          clearTimeout(timer);
          reject(error);
        });
        response.on("aborted", () => {
          req.destroy(
            new Error("Webhook response ended before its body was complete")
          );
        });
        response.on("end", () => {
          clearTimeout(timer);
          const body = [204, 205, 304].includes(status)
            ? null
            : new Uint8Array(Buffer.concat(chunks));
          try {
            resolve(new Response(body, { status }));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Webhook delivery timed out")),
      TIMEOUT_MS
    );
    req.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string") {
        req.destroy(new Error("Webhook body must be a serialized JSON string"));
        return;
      }
      req.write(init.body);
    }
    req.end();
  });
}
