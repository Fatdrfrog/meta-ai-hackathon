/**
 * PostHog Server-Side Client
 *
 * Singleton PostHog client for server-side tracking in API routes and server components.
 * Uses posthog-node for Node.js environments.
 */

import { PostHog } from "posthog-node";
import { normalizeUrlBase } from "@icecore/shared/lib/value-utils";

const POSTHOG_PROJECT_API_KEY =
  process.env.POSTHOG_PROJECT_API_KEY ||
  process.env.NEXT_PUBLIC_POSTHOG_KEY ||
  "";
const DEFAULT_POSTHOG_CAPTURE_HOST = "https://us.i.posthog.com";

const POSTHOG_HOST =
  normalizeUrlBase(process.env.POSTHOG_CAPTURE_HOST) ||
  normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_HOST) ||
  normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_HOST) ||
  DEFAULT_POSTHOG_CAPTURE_HOST;

let posthogClient: PostHog | null = null;

type RequestFlushScheduler = (flush: () => Promise<void>) => void;
const REQUEST_FLUSH_SCHEDULER_KEY = "__icecoreServerPostHogRequestFlush__";
type PostHogGlobal = typeof globalThis & {
  [REQUEST_FLUSH_SCHEDULER_KEY]?: RequestFlushScheduler | null;
};

/** Web supplies Next's request lifetime; worker imports stay independent of Next. */
export function configureServerPostHogRequestFlush(
  scheduler: RequestFlushScheduler | null
): void {
  // Instrumentation and routes can have separate module graphs in Next.
  (globalThis as PostHogGlobal)[REQUEST_FLUSH_SCHEDULER_KEY] = scheduler;
}

async function flushClient(client: PostHog): Promise<void> {
  try {
    // posthog-node flush also awaits asynchronous capture/identify preparation.
    await client.flush();
  } catch (error) {
    console.error("PostHog flush error:", error);
  }
}

function scheduleRequestFlush(client: PostHog): void {
  const schedule = (globalThis as PostHogGlobal)[REQUEST_FLUSH_SCHEDULER_KEY];
  if (!schedule) return;

  try {
    // Register while the caller is still handling the request, before the SDK
    // asynchronously enqueues capture/identify. The callback flushes afterward.
    schedule(() => flushClient(client));
  } catch {
    // A web process can also run startup/background work outside a request.
    // Its captures retain the SDK's normal automatic flush behavior.
  }
}

/**
 * Get or create the PostHog server-side client instance
 * Returns null if PostHog is not configured (graceful degradation)
 */
export function getPostHogClient(): PostHog | null {
  // Return null if no API key is configured
  if (!POSTHOG_PROJECT_API_KEY) {
    return null;
  }

  // Return existing client if already initialized
  if (posthogClient) {
    scheduleRequestFlush(posthogClient);
    return posthogClient;
  }

  try {
    // Initialize PostHog client
    posthogClient = new PostHog(POSTHOG_PROJECT_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1, // Start delivery promptly in both web and worker runtimes.
      flushInterval: 0,
    });

    scheduleRequestFlush(posthogClient);
    return posthogClient;
  } catch (error) {
    // Log error but don't throw - allow app to continue without PostHog
    console.error("Failed to initialize PostHog server client:", error);
    return null;
  }
}

/**
 * Flush server-side PostHog events without shutting down the shared client.
 * Handlers that already await this helper can retain their explicit boundary.
 */
export async function flushServerPostHog(): Promise<void> {
  if (posthogClient) {
    await flushClient(posthogClient);
  }
}

/**
 * Shutdown PostHog client gracefully
 * Should be called on app shutdown or in cleanup functions
 */
export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    try {
      await posthogClient.shutdown();
      posthogClient = null;
    } catch (error) {
      console.error("Error shutting down PostHog client:", error);
    }
  }
}
