import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/is-bot";
import path from "node:path";
import { extendHtmlLimitedBots } from "./src/lib/public-crawlers";
import { validateSupabasePublicKey } from "./src/lib/supabase/public-key";

// Some tooling loads Next config before loading .env files. Reject a configured
// privileged key immediately; public client factories also require a key.
if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined) {
  validateSupabasePublicKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

const nextConfig: NextConfig = {
  htmlLimitedBots: extendHtmlLimitedBots(HTML_LIMITED_BOT_UA_RE),
  devIndicators: false,
  transpilePackages: ["csv-parse"],
  allowedDevOrigins: ["127.0.0.1"],
  typedRoutes: true, // Enable typed routes for compile-time safety
  typescript: {
    tsconfigPath:
      process.env.NODE_ENV === "production"
        ? "tsconfig.build.json"
        : "tsconfig.json",
  },
  serverExternalPackages: [
    "@temporalio/client",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
    // Turbopack follows the AMD branch in pubsub's generated protos and
    // cannot resolve protobufjs/minimal. Load the Node client at runtime.
    "@google-cloud/pubsub",
  ],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  outputFileTracingIncludes: {
    "/api/telegram/webhook/[sourceId]": [
      "node_modules/@temporalio/client/**/*",
      "node_modules/@grpc/grpc-js/**/*",
      "node_modules/@grpc/proto-loader/**/*",
      "node_modules/@google-cloud/pubsub/**/*",
    ],
    "/api/webhooks/whatsapp": [
      "node_modules/@temporalio/client/**/*",
      "node_modules/@grpc/grpc-js/**/*",
      "node_modules/@grpc/proto-loader/**/*",
      "node_modules/@google-cloud/pubsub/**/*",
    ],
    "/api/webhooks/instagram": [
      "node_modules/@temporalio/client/**/*",
      "node_modules/@grpc/grpc-js/**/*",
      "node_modules/@grpc/proto-loader/**/*",
      "node_modules/@google-cloud/pubsub/**/*",
    ],
    "/api/widget/conversations": [
      "node_modules/@temporalio/client/**/*",
      "node_modules/@grpc/grpc-js/**/*",
      "node_modules/@grpc/proto-loader/**/*",
      "node_modules/@google-cloud/pubsub/**/*",
    ],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "wnycyavumykzejnjelfb.supabase.co",
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "api.airi.chat",
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  async redirects() {
    return [
      {
        source: "/pricing",
        destination: "/",
        permanent: true,
      },
      // Retired support-era docs pages.
      ...[
        "/get-started",
        "/integrations",
        "/knowledge-base",
        "/performance",
      ].map(source => ({ source, destination: "/", permanent: true })),
    ];
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
