import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { configureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import { configureServerPostHogRequestFlush } from "@/lib/posthog/server";
import { after } from "next/server";

const POSTHOG_PROJECT_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
const DEFAULT_POSTHOG_LOGS_URL = "https://us.i.posthog.com/i/v1/logs";

function getPostHogLogsUrl(): string {
  const configuredUrl =
    process.env.POSTHOG_LOGS_URL?.trim() ||
    process.env.POSTHOG_LOGS_HOST?.trim();
  if (!configuredUrl) {
    return DEFAULT_POSTHOG_LOGS_URL;
  }

  const normalizedHost = configuredUrl.replace(/\/+$/, "");
  if (normalizedHost.endsWith("/i/v1/logs")) {
    return normalizedHost;
  }

  return `${normalizedHost}/i/v1/logs`;
}

// Create LoggerProvider outside register() so it can be exported and flushed in route handlers
export const loggerProvider = new LoggerProvider({
  resource: resourceFromAttributes({ "service.name": "@icecore/web" }),
  processors: POSTHOG_PROJECT_TOKEN
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: getPostHogLogsUrl(),
            headers: {
              Authorization: `Bearer ${POSTHOG_PROJECT_TOKEN}`,
              "Content-Type": "application/json",
            },
          })
        ),
      ]
    : [],
});

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    logs.setGlobalLoggerProvider(loggerProvider);
    configureServerPostHogRequestFlush(flush => after(flush));
    configureMediaApiCreativeAssetReadUrlPort();
  }
}
