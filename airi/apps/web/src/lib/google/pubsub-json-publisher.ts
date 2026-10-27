import "server-only";
import type { PubSub, Topic } from "@google-cloud/pubsub";
import { createHash } from "node:crypto";

import {
  getGoogleCloudProjectId,
  getVercelGcpAccessToken,
  hasVercelGcpWorkloadIdentityConfig,
  invalidateVercelGcpAccessTokenCache,
  parseGoogleServiceAccountJson,
} from "@/lib/google/gcp-auth";

export type GooglePubSubJsonPublishResult = {
  ok: boolean;
  messageId?: string | null;
};

const cachedPublishers = new Map<string, { client: PubSub; topic: Topic }>();
const MAX_CACHED_PUBLISHERS = 16;

export async function publishGooglePubSubJsonMessage(input: {
  projectIdEnvName: string;
  topic: string;
  message: unknown;
  orderingKey: string;
  attributes?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<GooglePubSubJsonPublishResult> {
  input.signal?.throwIfAborted();
  if (hasVercelGcpWorkloadIdentityConfig()) {
    return publishWithRest(input);
  }
  return publishWithClient(input);
}

class PubSubRestPublishError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string
  ) {
    super(
      `Pub/Sub publish failed: HTTP ${status} ${responseText.slice(0, 500)}`
    );
    this.name = "PubSubRestPublishError";
  }
}

async function publishWithRest(input: {
  projectIdEnvName: string;
  topic: string;
  message: unknown;
  orderingKey: string;
  attributes?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<GooglePubSubJsonPublishResult> {
  const projectId = getGoogleCloudProjectId(input.projectIdEnvName);
  if (!projectId) {
    throw new Error("Google Cloud project id is not configured.");
  }

  try {
    return await publishWithRestAccessToken({ input, projectId });
  } catch (error) {
    if (
      !(error instanceof PubSubRestPublishError) ||
      (error.status !== 401 && error.status !== 403)
    ) {
      throw error;
    }

    // A warm Vercel function can retain an access token through an
    // infrastructure-side revocation. Refresh exactly once, rather than
    // turning authentication failures into a retry loop.
    invalidateVercelGcpAccessTokenCache();
    return publishWithRestAccessToken({ input, projectId });
  }
}

async function publishWithRestAccessToken(params: {
  input: {
    projectIdEnvName: string;
    topic: string;
    message: unknown;
    orderingKey: string;
    attributes?: Record<string, string>;
    signal?: AbortSignal;
  };
  projectId: string;
}): Promise<GooglePubSubJsonPublishResult> {
  const { input, projectId } = params;

  const token = await getVercelGcpAccessToken();
  const response = await fetch(
    `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/topics/${encodeURIComponent(input.topic)}:publish`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        messages: [
          {
            data: Buffer.from(JSON.stringify(input.message)).toString("base64"),
            orderingKey: input.orderingKey,
            attributes: input.attributes,
          },
        ],
      }),
      signal: input.signal,
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new PubSubRestPublishError(response.status, responseText);
  }

  const payload = JSON.parse(responseText || "{}") as {
    messageIds?: string[];
  };
  return { ok: true, messageId: payload.messageIds?.[0] || null };
}

async function publishWithClient(input: {
  projectIdEnvName: string;
  topic: string;
  message: unknown;
  orderingKey: string;
  attributes?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<GooglePubSubJsonPublishResult> {
  const { PubSub } = await import("@google-cloud/pubsub");
  const serviceAccount = parseGoogleServiceAccountJson();
  const projectId =
    getGoogleCloudProjectId(input.projectIdEnvName) ||
    serviceAccount?.project_id;
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        topic: input.topic,
        serviceAccount,
        emulator: process.env.PUBSUB_EMULATOR_HOST,
      })
    )
    .digest("hex");
  let publisher = cachedPublishers.get(key);
  if (!publisher) {
    const client = new PubSub({
      projectId: projectId || undefined,
      ...(serviceAccount ? { credentials: serviceAccount } : {}),
    });
    publisher = {
      client,
      topic: client.topic(input.topic, { messageOrdering: true }),
    };
    if (cachedPublishers.size < MAX_CACHED_PUBLISHERS)
      cachedPublishers.set(key, publisher);
  }
  try {
    const messageId = await publisher.topic.publishMessage({
      json: input.message,
      orderingKey: input.orderingKey,
      attributes: input.attributes,
    });
    input.signal?.throwIfAborted();
    return { ok: true, messageId };
  } catch (error) {
    // The SDK pauses an ordering key after a publish failure. Re-enable it for
    // the durable outbox retry, or every later message on that chat would fail.
    publisher.topic.resumePublishing(input.orderingKey);
    throw error;
  } finally {
    if (!cachedPublishers.has(key))
      await publisher.client.close().catch(() => undefined);
  }
}
