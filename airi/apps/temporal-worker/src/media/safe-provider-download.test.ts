import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  downloadProviderVideoToFile,
  MAX_GENERATED_VIDEO_BYTES,
  validateProviderDownloadUrl,
} from "./safe-provider-download";

function response(
  statusCode: number,
  headers: Record<string, string>,
  chunks: Buffer[],
) {
  const stream = Readable.from(chunks) as Readable & {
    statusCode?: number;
    headers: Record<string, string>;
  };
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function endlessResponse(statusCode: number, headers: Record<string, string>) {
  const stream = new Readable({ read() {} }) as Readable & {
    statusCode?: number;
    headers: Record<string, string>;
  };
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test("requires HTTPS and enforces stable-origin allowlists", () => {
  assert.throws(
    () =>
      validateProviderDownloadUrl("http://cdn.example.com/a.mp4", {
        kind: "stable",
        hostnames: ["cdn.example.com"],
      }),
    /HTTPS/i,
  );
  assert.throws(
    () =>
      validateProviderDownloadUrl("https://evil.example/a.mp4", {
        kind: "stable",
        hostnames: ["cdn.example.com"],
      }),
    /not allowed/i,
  );
  assert.throws(
    () =>
      validateProviderDownloadUrl("https://[::ffff:7f00:1]/a.mp4", {
        kind: "dynamic",
      }),
    /private|local/i,
  );
  assert.throws(
    () =>
      validateProviderDownloadUrl("https://[::ffff:a9fe:a9fe]/a.mp4", {
        kind: "dynamic",
      }),
    /private|local/i,
  );
});

test("pins a public DNS result into the actual request lookup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const destinationPath = path.join(dir, "result.mp4");
  let pinnedAddress = "";
  try {
    const result = await downloadProviderVideoToFile({
      url: "https://dynamic.example/video.mp4",
      destinationPath,
      policy: { kind: "dynamic" },
      deps: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: (options, handler) => {
          options.lookup?.("dynamic.example", {}, (_error, address) => {
            pinnedAddress = String(address);
          });
          queueMicrotask(() =>
            handler(
              response(200, { "content-type": "video/mp4" }, [
                Buffer.from("video"),
              ]),
            ),
          );
          return {
            on: () => undefined,
            destroy: () => undefined,
            end: () => undefined,
          };
        },
      },
    });
    assert.equal(pinnedAddress, "93.184.216.34");
    assert.equal(await readFile(destinationPath, "utf8"), "video");
    assert.equal(result.fileSize, 5);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal("finalUrl" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pins a public IPv6 literal without sending URL brackets to the socket", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const destinationPath = path.join(dir, "result.mp4");
  let socketHostname = "";
  try {
    await downloadProviderVideoToFile({
      url: "https://[2606:4700:4700::1111]/video.mp4",
      destinationPath,
      policy: { kind: "dynamic" },
      deps: {
        resolve: async () => {
          throw new Error("IPv6 literals must not use DNS");
        },
        request: (options, handler) => {
          socketHostname = String(options.hostname);
          queueMicrotask(() =>
            handler(
              response(200, { "content-type": "video/mp4" }, [
                Buffer.from("video"),
              ]),
            ),
          );
          return {
            on: () => undefined,
            destroy: () => undefined,
            end: () => undefined,
          };
        },
      },
    });
    assert.equal(socketHostname, "2606:4700:4700::1111");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns the pinned address array when Node requests lookup with all true", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const destinationPath = path.join(dir, "result.mp4");
  let lookupResult: unknown;
  try {
    await downloadProviderVideoToFile({
      url: "https://dynamic.example/video.mp4",
      destinationPath,
      policy: { kind: "dynamic" },
      deps: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: (options, handler) => {
          options.lookup?.("dynamic.example", { all: true }, ((
            error: Error | null,
            addresses: unknown,
          ) => {
            assert.equal(error, null);
            lookupResult = addresses;
          }) as never);
          queueMicrotask(() =>
            handler(
              response(200, { "content-type": "video/mp4" }, [
                Buffer.from("video"),
              ]),
            ),
          );
          return {
            on: () => undefined,
            destroy: () => undefined,
            end: () => undefined,
          };
        },
      },
    });
    assert.deepEqual(lookupResult, [{ address: "93.184.216.34", family: 4 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not reuse a pooled socket across sequential same-host pins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const resolvedAddresses = ["93.184.216.34", "93.184.216.35"];
  const connectedAddresses: string[] = [];
  let resolveIndex = 0;
  let pooledAddress = "";
  try {
    for (let index = 0; index < resolvedAddresses.length; index += 1) {
      await downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath: path.join(dir, `result-${index}.mp4`),
        policy: { kind: "dynamic" },
        deps: {
          resolve: async () => [
            { address: resolvedAddresses[resolveIndex++]!, family: 4 },
          ],
          request: (options, handler) => {
            let connectedAddress = pooledAddress;
            if (options.agent === false || !connectedAddress) {
              options.lookup?.("dynamic.example", { all: true }, ((
                error: Error | null,
                addresses: Array<{ address: string }>,
              ) => {
                assert.equal(error, null);
                connectedAddress = addresses[0]!.address;
              }) as never);
              if (options.agent !== false) pooledAddress = connectedAddress;
            }
            connectedAddresses.push(connectedAddress);
            queueMicrotask(() =>
              handler(
                response(200, { "content-type": "video/mp4" }, [
                  Buffer.from("video"),
                ]),
              ),
            );
            return {
              on: () => undefined,
              destroy: () => undefined,
              end: () => undefined,
            };
          },
        },
      });
    }

    assert.deepEqual(connectedAddresses, resolvedAddresses);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends explicit authentication headers only on the initial request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let requestCount = 0;
  try {
    await downloadProviderVideoToFile({
      url: "https://dynamic.example/video.mp4",
      destinationPath: path.join(dir, "result.mp4"),
      policy: { kind: "dynamic" },
      authorization: "Bearer legacy-secret",
      requestHeaders: {
        Host: "attacker.example",
        "x-goog-api-key": "google-secret",
      },
      deps: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: (options, handler) => {
          requestCount += 1;
          seenHeaders.push(
            options.headers as Record<string, string | string[] | undefined>,
          );
          const incoming =
            requestCount === 1
              ? response(
                  302,
                  { location: "https://dynamic.example/final.mp4" },
                  [],
                )
              : response(200, { "content-type": "video/mp4" }, [
                  Buffer.from("video"),
                ]);
          queueMicrotask(() => handler(incoming));
          return {
            on: () => undefined,
            destroy: () => undefined,
            end: () => undefined,
          };
        },
      },
    });

    assert.equal(seenHeaders[0]?.Host, "dynamic.example");
    assert.equal(seenHeaders[0]?.Authorization, "Bearer legacy-secret");
    assert.equal(seenHeaders[0]?.["x-goog-api-key"], "google-secret");
    assert.deepEqual(seenHeaders[1], { Host: "dynamic.example" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects DNS rebinding targets and redirects to private IPs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  try {
    await assert.rejects(
      downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath: path.join(dir, "private.mp4"),
        policy: { kind: "dynamic" },
        deps: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
      }),
      /private|reserved/i,
    );

    await assert.rejects(
      downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath: path.join(dir, "redirect.mp4"),
        policy: { kind: "dynamic" },
        deps: {
          resolve: async (hostname) =>
            hostname === "dynamic.example"
              ? [{ address: "93.184.216.34", family: 4 }]
              : [{ address: "127.0.0.1", family: 4 }],
          request: (_options, handler) => {
            queueMicrotask(() =>
              handler(
                response(
                  302,
                  { location: "https://private.example/video.mp4" },
                  [],
                ),
              ),
            );
            return {
              on: () => undefined,
              destroy: () => undefined,
              end: () => undefined,
            };
          },
        },
      }),
      /private|reserved/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "applies the total download deadline while DNS is unresolved",
  { timeout: 1_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
    try {
      await assert.rejects(
        downloadProviderVideoToFile({
          url: "https://dynamic.example/video.mp4",
          destinationPath: path.join(dir, "timeout.mp4"),
          policy: { kind: "dynamic" },
          timeoutMs: 20,
          deps: {
            resolve: async () => new Promise(() => undefined),
          },
        }),
        /timed out/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("rejects zero bytes, HTML, 50 MiB plus one, and a fourth redirect", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const publicResolve = async () => [
    { address: "93.184.216.34", family: 4 as const },
  ];
  try {
    for (const [name, incoming, pattern] of [
      ["empty", response(200, { "content-type": "video/mp4" }, []), /empty/i],
      [
        "html",
        response(200, { "content-type": "text\/html" }, [
          Buffer.from("<html>"),
        ]),
        /content type|HTML/i,
      ],
      [
        "mislabeled-html",
        response(200, { "content-type": "application/octet-stream" }, [
          Buffer.from("  <!doctype html><html>"),
        ]),
        /HTML/i,
      ],
      [
        "large",
        response(
          200,
          {
            "content-type": "video/mp4",
            "content-length": String(50 * 1024 * 1024 + 1),
          },
          [],
        ),
        /50 MiB|size limit/i,
      ],
    ] as const) {
      await assert.rejects(
        downloadProviderVideoToFile({
          url: "https://dynamic.example/video.mp4",
          destinationPath: path.join(dir, `${name}.mp4`),
          policy: { kind: "dynamic" },
          deps: {
            resolve: publicResolve,
            request: (_options, handler) => {
              queueMicrotask(() => handler(incoming));
              return {
                on: () => undefined,
                destroy: () => undefined,
                end: () => undefined,
              };
            },
          },
        }),
        pattern,
      );
    }

    await assert.rejects(
      downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath: path.join(dir, "redirects.mp4"),
        policy: { kind: "dynamic" },
        deps: {
          resolve: publicResolve,
          request: (_options, handler) => {
            queueMicrotask(() =>
              handler(
                response(
                  302,
                  { location: "https://dynamic.example/next.mp4" },
                  [],
                ),
              ),
            );
            return {
              on: () => undefined,
              destroy: () => undefined,
              end: () => undefined,
            };
          },
        },
      }),
      /too many redirects/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("destroys rejected redirect, HTTP error, and MIME response bodies", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const publicResolve = async () => [
    { address: "93.184.216.34", family: 4 as const },
  ];
  const cases = [
    {
      name: "redirect",
      incoming: endlessResponse(302, {
        location: "https://127.0.0.1/video.mp4",
      }),
      pattern: /private|local/i,
    },
    {
      name: "http-error",
      incoming: endlessResponse(503, { "content-type": "video/mp4" }),
      pattern: /HTTP 503/i,
    },
    {
      name: "mime",
      incoming: endlessResponse(200, { "content-type": "text/plain" }),
      pattern: /content type/i,
    },
  ];

  try {
    for (const item of cases) {
      await assert.rejects(
        downloadProviderVideoToFile({
          url: "https://dynamic.example/video.mp4",
          destinationPath: path.join(dir, `${item.name}.mp4`),
          policy: { kind: "dynamic" },
          deps: {
            resolve: publicResolve,
            request: (_options, handler) => {
              queueMicrotask(() => handler(item.incoming));
              return {
                on: () => undefined,
                destroy: () => undefined,
                end: () => undefined,
              };
            },
          },
        }),
        item.pattern,
      );
      assert.equal(item.incoming.destroyed, true, item.name);
    }
  } finally {
    for (const item of cases) item.incoming.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a streamed 50 MiB plus one byte without a content length", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const incoming = response(200, { "content-type": "video/mp4" }, [
    Buffer.alloc(MAX_GENERATED_VIDEO_BYTES),
    Buffer.alloc(1),
  ]);
  try {
    await assert.rejects(
      downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath: path.join(dir, "streamed-large.mp4"),
        policy: { kind: "dynamic" },
        deps: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          request: (_options, handler) => {
            queueMicrotask(() => handler(incoming));
            return {
              on: () => undefined,
              destroy: () => undefined,
              end: () => undefined,
            };
          },
        },
      }),
      /50 MiB|size limit/i,
    );
  } finally {
    incoming.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves a destination that existed before an exclusive create failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-safe-download-test-"));
  const destinationPath = path.join(dir, "existing.mp4");
  await writeFile(destinationPath, "existing-video");
  try {
    await assert.rejects(
      downloadProviderVideoToFile({
        url: "https://dynamic.example/video.mp4",
        destinationPath,
        policy: { kind: "dynamic" },
        deps: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          request: (_options, handler) => {
            queueMicrotask(() =>
              handler(
                response(200, { "content-type": "video/mp4" }, [
                  Buffer.from("replacement"),
                ]),
              ),
            );
            return {
              on: () => undefined,
              destroy: () => undefined,
              end: () => undefined,
            };
          },
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    assert.equal(await readFile(destinationPath, "utf8"), "existing-video");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
