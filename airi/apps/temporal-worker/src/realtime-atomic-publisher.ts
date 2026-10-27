import type { RealtimeValkeyClient } from "./realtime-valkey.js";

export type AtomicPublishInput = {
  dedupeKey: string;
  ttlSeconds: number;
  channel: string;
  message: string;
};

export type AtomicPublishResult =
  | { kind: "published"; subscriberCount: number }
  | { kind: "duplicate" }
  | { kind: "publish_failed" }
  | { kind: "ambiguous" };

export type AtomicRealtimePublisher = {
  publishOnce(input: AtomicPublishInput): Promise<AtomicPublishResult>;
};

const ATOMIC_PUBLISH_ONCE_SCRIPT = `
if redis.call("SET", KEYS[1], "1", "EX", ARGV[1], "NX") then
  local published = redis.pcall("PUBLISH", ARGV[2], ARGV[3])
  if type(published) == "table" and published.err then
    redis.call("DEL", KEYS[1])
    return {-2, 0}
  end
  return {1, published}
end
return {-1, 0}`;

type ScriptOutcome =
  | { kind: "published"; subscriberCount: number }
  | { kind: "duplicate" }
  | { kind: "publish_failed" }
  | { kind: "ambiguous" };

function parseScriptReply(reply: unknown): ScriptOutcome {
  if (!Array.isArray(reply) || reply.length !== 2) {
    return { kind: "ambiguous" };
  }

  const [code, subscriberCount] = reply;
  if (
    code === 1 &&
    typeof subscriberCount === "number" &&
    Number.isSafeInteger(subscriberCount) &&
    subscriberCount >= 0
  ) {
    return { kind: "published", subscriberCount };
  }
  if (code === -1 && Object.is(subscriberCount, 0)) {
    return { kind: "duplicate" };
  }
  if (code === -2 && Object.is(subscriberCount, 0)) {
    return { kind: "publish_failed" };
  }
  return { kind: "ambiguous" };
}

async function executeAtomicPublish(input: {
  client: RealtimeValkeyClient;
  script: string;
  key: string;
  ttl: number;
  channel: string;
  message: string;
}): Promise<ScriptOutcome> {
  try {
    const reply = await input.client.eval(input.script, {
      keys: [input.key],
      arguments: [String(input.ttl), input.channel, input.message],
    });
    return parseScriptReply(reply);
  } catch {
    return { kind: "ambiguous" };
  }
}

export function createAtomicRealtimePublisher(
  client: RealtimeValkeyClient,
): AtomicRealtimePublisher {
  return {
    async publishOnce(input: AtomicPublishInput): Promise<AtomicPublishResult> {
      return executeAtomicPublish({
        client,
        script: ATOMIC_PUBLISH_ONCE_SCRIPT,
        key: input.dedupeKey,
        ttl: input.ttlSeconds,
        channel: input.channel,
        message: input.message,
      });
    },
  };
}
