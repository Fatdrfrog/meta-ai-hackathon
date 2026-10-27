# airi.chat Web App

## Local setup

From the repository root, use Node.js 24 and the pnpm version pinned in
`package.json`, then run `pnpm install`.

Create `apps/web/.env.local`; this app has no tracked `.env.example`. Core
authenticated flows need these values:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
MONGODB_URI=mongodb://127.0.0.1:27017/airi_dev
ENCRYPTION_SECRET=
```

Use a development Supabase project and MongoDB instance. Keep the service-role
key and encryption secret server-only. Generate a local encryption secret with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
and keep it stable for data encrypted by that development environment.

Platform text AI (AI replies, classification, extraction, summaries, scenario
generation) runs on Claude and needs a development Anthropic key:

```dotenv
ANTHROPIC_API_KEY=
```

Without it, text generation falls back to Vertex Gemini when that is
configured. Embeddings, media analysis and image/video generation still use
Google (Gemini text on `@google/genai` with Google ADC or the service account;
media generation with `GEMINI_API_KEY`); see the variables below.

Run `pnpm dev:web` and open `http://localhost:3000`. Provider-specific flows
need the optional settings below; a local empty MongoDB does not contain
existing conversation or analytics data. Worker development also reads this
file after its own env files, as described in the
[worker environment loading guide](../temporal-worker/README.md#environment-loading).

## Environment variables

- TELEGRAM_BOT_TOKEN
- NEXT_PUBLIC_REALTIME_GATEWAY_URL, REALTIME_TOKEN_SECRET
- OPENAI_API_KEY
- Platform text AI (chat, summarization, classification, extraction, scenario generation): providers are tried in `AI_CHAT_PROVIDER_ORDER` order (optional comma list, default `anthropic,vertex`), so Claude runs first and Vertex Gemini is only the outage fallback; a provider that is not configured is skipped. Workspaces billed with their own Google AI key stay on Gemini. (`AI_PRIMARY_PROVIDER` is no longer used for ordering.)
- ANTHROPIC_API_KEY (Claude via the Anthropic API; required for platform text AI. Server-only; configure it as a secret/sensitive value)
- ANTHROPIC_WORKSPACE_ID (optional, non-secret): sent as the `anthropic-workspace-id` header. Set it only when the key is not scoped to a workspace (the API answers 400 "must include the anthropic-workspace-id header"). A missing or rejected workspace disables Claude for the runtime with one warning, and text falls back to Vertex Gemini.
- ANTHROPIC_AI_ENABLED=true|false (optional, default true)
- ANTHROPIC_LIGHT_MODEL (optional, default `claude-haiku-4-5`: classification, JSON extraction, short translations, HyDE, query cleanup), ANTHROPIC_HEAVY_MODEL (optional, default `claude-sonnet-5-5`: customer-facing replies, reranking, verification, coaching, summaries, AI chat drafts, KB article translation, Meta Ads planning, prompt optimizer), ANTHROPIC_REASONING_MODEL (optional, default `claude-opus-5-5`: scenario generator). Use exact model ids without date suffixes.
- VERTEX_AI_ENABLED=true|false (optional, default true)
- Gemini on Vertex AI (text outage fallback, embeddings, media analysis) runs on `@google/genai` with Google ADC or the service account; image/video generation uses `GEMINI_API_KEY`.
- VERTEX_FALLBACK_MODEL, VERTEX_MULTIMODAL_MODEL (optional Gemini model ids). Summaries run on the heavy tier, so their Gemini fallback uses `VERTEX_GEMINI_HEAVY_MODEL`.
- AIRI_AUTO_REPLY=true|false (default: false)
- AIRI_AUTO_REPLY_MODE=mention|always (default: mention)
- Airi chat turns always run as durable runs (`airichatruns`) that keep going when the client disconnects, can be resumed (`GET .../airi-chats/[threadId]/runs/[runId]/stream`) and stopped (`POST .../runs/[runId]/cancel`). Build the run indexes first (`pnpm --filter @icecore/web ensure:mongo-indexes --airi-chat-only`): the unique indexes are what make a retried send attach and keep one running run per chat.
- Meta Ads turns run as a native Claude tool-use loop (Claude only; without Claude the turn fails with `meta_ads_requires_claude`).
- UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (optional, for cache/rate limits)
- `GCS_BULK_DISPATCH_BUCKET` (optional; falls back to `GCS_CREATIVE_ASSETS_BUCKET`) for large Temporal bulk-campaign payload staging; auth reuses existing Vercel GCP Workload Identity Federation (`GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_WORKLOAD_IDENTITY_POOL_*`) — same as Pub/Sub. Grant that SA object create/get on the bucket.
- META_APP_ID, META_APP_SECRET (Meta app credentials; WhatsApp + legacy fallback)
- NEXT_PUBLIC_META_APP_ID (for client-side Meta SDK)
- `NEXT_PUBLIC_APP_URL` (canonical public app origin; managed WhatsApp Flow endpoint URIs require an explicitly configured public HTTPS URL, normalize paths/trailing slashes to the origin, and reject localhost or inferred request hosts)
- NEXT_PUBLIC_INSTAGRAM_APP_ID (recommended for Instagram Business Login; fallback: `NEXT_PUBLIC_META_APP_ID`)
- INSTAGRAM_APP_SECRET (recommended for Instagram Business Login; fallback: `META_APP_SECRET`)
- NEXT_PUBLIC_INSTAGRAM_REDIRECT_URI (Instagram Direct Login OAuth callback URL, recommended: `/api/sources/instagram/callback`)
- NEXT_PUBLIC_INSTAGRAM_FB_REDIRECT_URI (Facebook Login for Instagram callback URL, default: `/instagram/callback`)
- INSTAGRAM_VERIFY_TOKEN (Instagram webhook verification token)
- NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID (for WhatsApp Business app coexistence Embedded Signup; defaults to the dedicated airi.chat configuration) - **Found in Meta Dashboard**: Facebook Login for Business > Configurations
- NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID (for full Cloud API Embedded Signup) - **Found in Meta Dashboard**: Facebook Login for Business > Configurations
- WhatsApp Embedded Signup uses stable v4 through product selection in the Facebook Login for Business configuration. Do not add `extras.version` or `extras.sessionInfoVersion` overrides; the old `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_SESSION_VERSION` variable is no longer read.
- WHATSAPP_VERIFY_TOKEN (for webhook verification)
- NEXT_PUBLIC_WHATSAPP_REDIRECT_URI (OAuth callback URL)
- WHATSAPP_CALL_PUBSUB_PROJECT_ID, WHATSAPP_CALL_PUBSUB_TOPIC (optional, routes `calls` webhook work to the dedicated call queue)
- LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (for WhatsApp call media token issuance)
- LIVEKIT_MEDIA_TOKEN_TTL_SECONDS (optional, default: 600)
- NEXT_PUBLIC_POSTHOG_KEY (project token for browser capture and fallback server ingestion)
- NEXT_PUBLIC_POSTHOG_CAPTURE_HOST (browser capture endpoint or reverse proxy; default: <https://us.i.posthog.com>; `NEXT_PUBLIC_POSTHOG_HOST` is the legacy fallback)
- NEXT_PUBLIC_POSTHOG_UI_HOST (PostHog app URL; default: <https://us.posthog.com>)
- POSTHOG_PERSONAL_API_KEY (personal API key for PostHog `/query/`; `POSTHOG_API_KEY` remains a legacy fallback)
- POSTHOG_PROJECT_ID (PostHog project ID for `/query/`)
- POSTHOG_QUERY_HOST (query API host; default: <https://us.posthog.com>; use the app host, not the capture proxy)
- POSTHOG_PROJECT_API_KEY (optional backend override for server-side ingestion)
- POSTHOG_CAPTURE_HOST (optional backend capture endpoint override)
- META_WEBHOOK_SIGNATURE_MODE (optional: `off|log|enforce`, default: `log` in production, `off` in development)
- CRON_SECRET (optional; when set, cron routes require `Authorization: Bearer <CRON_SECRET>`)

See [PostHog integration](../../docs/posthog-integration.md) for privacy, identity,
request delivery, widget aggregation, and regression checks.

### TikTok Discovery platform OAuth (server-only)

TikTok Discovery uses one internal airi.chat platform credential. Keep these
variables server-only; they are not customer or workspace OAuth settings.

```dotenv
TIKTOK_BUSINESS_APP_ID=
TIKTOK_BUSINESS_APP_SECRET=
TIKTOK_BUSINESS_REDIRECT_URI=https://www.airi.chat/api/internal/tiktok/callback
TIKTOK_DISCOVERY_ADVERTISER_ID=
```

`TIKTOK_DISCOVERY_ADVERTISER_ID` is required only when OAuth returns multiple
authorized advertisers. In the TikTok developer portal, request only
`Creative Management -> Discovery` and register the exact production callback
shown above.

## Local Airi Chat Runtime

If local chat loading fails with `querySrv ECONNREFUSED _mongodb._tcp...`, the
app is trying to use an Atlas SRV URI that local dev cannot resolve. Set
`MONGODB_URI` in `apps/web/.env.local` to a development MongoDB connection
string in standard form:

- `MONGODB_URI=<development mongodb:// connection string>`

Do not use production database credentials for routine local development.

To test the GCP AI gateway locally:

1. Start the gateway with `AIRI_RUNTIME_MODE=ai-gateway` and `AI_GATEWAY_DISABLE_AUTH=true`.
2. Run `pnpm --filter @icecore/temporal-worker start:gateway`.
3. In `apps/web/.env.local`, set `GCP_AI_GATEWAY_URL=http://127.0.0.1:8080`.

If the local gateway returns `Missing bearer token`, it was started without `AI_GATEWAY_DISABLE_AUTH=true`.

## Instagram Integration (Multitenant)

### Flow (Option B: Instagram Business Login)

This implementation uses **Instagram Business Login** (not Facebook Page linking):

1. Redirect user to `https://www.instagram.com/oauth/authorize`
2. Exchange `code` via `POST https://api.instagram.com/oauth/access_token`
3. Exchange short-lived token via `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`
4. Resolve account identity via `GET https://graph.instagram.com/v25.0/me?fields=id,user_id,username,account_type`
5. Persist encrypted long-lived token and account IDs in `sources.credentials`

### Flow (Option A: Facebook Login for Instagram)

This implementation also supports **Facebook Login for Instagram**:

1. Redirect user to `https://www.facebook.com/v25.0/dialog/oauth` with `extras={"setup":{"channel":"IG_API_ONBOARDING"}}`
2. Receive token fragment on `/instagram/callback`
3. Resolve eligible Pages + linked Instagram accounts via `GET /me/accounts`
4. Persist encrypted Page access token, `page_id`, and Instagram account ID in `sources.credentials`
5. Subscribe app to page `subscribed_apps` for Instagram messaging webhooks

### OAuth scopes (requested + App Review)

- `instagram_business_basic`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`

These are the scopes required by the current messaging + moderation integration.

### Reviewer prep (for your video)

- Show integration button click in workspace settings.
- Show Instagram consent screen with requested scopes.
- Show successful redirect back to integrations screen.
- Show webhook/event logs after sending a DM to the connected Instagram account.
- Show outbound reply from conversation UI to Instagram.
- Show where encrypted token + account IDs are stored per workspace.

### Token lifecycle

- We exchange short-lived token -> long-lived token (~60 days) on connect.
- Nightly cron `/api/cron/refreshInstagramTokens` refreshes with `ig_refresh_token` (fallback to legacy flow where needed).
- Tokens are encrypted at rest with AES-256-GCM (`ENCRYPTION_SECRET`).

### Webhooks

- Verify token via `INSTAGRAM_VERIFY_TOKEN` on GET.
- Subscribe account to `subscribed_apps` after connect.
- Handler processes **all** entries/events (not only the first event).
- Supports payloads under:
  - `entry[].messaging[]`
  - `entry[].changes[].value.messaging[]`

## WhatsApp Integration (Tech Provider)

### Embedded Signup v4 (Recommended)

Meta is rolling out Phone Number First in stable v4: customers enter and verify
their number before selecting or creating business assets. Some customers still
see the previous screen order during rollout. When coexistence is enabled,
Meta detects WhatsApp Business app numbers and selects that path automatically.
The explicit Business app connection option continues to use the supported
`featureType: "whatsapp_business_app_onboarding"` setting.

Meta will deprecate Embedded Signup v2 on **October 15, 2026**. The SDK launcher
uses the product-configured v4 flow and does not opt into `v4-public-preview`.
Changing the launcher alone does not migrate an old Meta configuration: verify
both configured IDs use the v4 product-selection setup below.
See Meta's [v4 guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4),
[default flow](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/default-flow),
and [version contract](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions).

WhatsApp Embedded Signup is the recommended onboarding flow for new customers. It provides:

- Automatic WhatsApp Business Account (WABA) creation
- Built-in phone number verification
- Streamlined customer experience
- Automatic webhook subscription
- Support for 555 test numbers

#### OAuth scopes (request and App Review)

Required scopes for WhatsApp messaging:

- whatsapp_business_management - Manage WABA settings, phone numbers
- whatsapp_business_messaging - Send/receive messages (CORE FEATURE)
- business_management - Access to business account

Ensure these are added in the Meta App and requested during both OAuth and Embedded Signup flows.

#### Facebook Login for Business Configuration

1. Navigate to Meta App Dashboard > Facebook Login for Business > Settings
2. Enable these Client OAuth settings:
   - Client OAuth login
   - Web OAuth login
   - Enforce HTTPS
   - Embedded Browser OAuth Login
   - Use Strict Mode for redirect URIs
   - Login with the JavaScript SDK
3. Add allowed domains: `airi.chat` and `www.airi.chat` (and `localhost` for development)
4. Create Embedded Signup configuration:
   - Go to Configurations panel (under "Facebook Login for Business" in left menu)
   - Click "+ Create Configuration"
   - Select "WhatsApp Embedded Signup" as Login Variation
   - Select Cloud API and the other products required by this integration, such as Marketing Messages API for WhatsApp. Product selection automatically enables v4 and selects the required assets and permissions.
   - Ensure the app has Advanced Access for every selected permission.
   - Copy the Cloud API configuration ID to `NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID`.
   - Copy the dedicated Business app configuration ID to `NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID` when overriding the existing airi.chat default.
   - Rebuild/redeploy after changing these public configuration IDs.

   `extras.setup` remains available for business prefill. Stable v4 returns session
   logging for every flow without a `sessionInfoVersion` parameter. Keep the
   `WA_EMBEDDED_SIGNUP` finish event and its WABA/phone IDs alongside the OAuth
   code; the callback resolves the actual connection mode from the finish event.
   Coexistence can return only a WABA ID, so the existing phone discovery and
   selection path remains required. Screen order must not determine completion.

#### Webhooks

Subscribe to these webhook fields in Meta App Dashboard > WhatsApp > Configuration:

- `messages` - Incoming/outgoing message events
- `account_update` - WABA onboarding completions (PARTNER_ADDED event), bans, verifications
- `account_alerts` - Messaging limit changes, business profile updates
- `phone_number_quality_update` - Quality rating changes
- `calls` - WhatsApp phone/video call lifecycle events for Full Cloud connections

Verify token via `WHATSAPP_VERIFY_TOKEN` on GET.

#### Tech Provider Requirements

As an approved Tech Provider:

- Can onboard up to 200 new business customers per 7-day rolling window
- Customers must add their own payment methods (no credit line sharing)
- Must have advanced access to `public_profile` permission (via App Review)
- Business tokens are customer-scoped, stored separately per workspace

#### Integration Flow

**Embedded Signup:**

1. Customer clicks "Connect with Embedded Signup"
2. Facebook SDK launches signup flow
3. Customer completes WABA creation and phone verification
4. SDK returns exchangeable code (30s TTL)
5. Backend exchanges code for business access token
6. Backend subscribes app to WABA webhooks automatically
7. Credentials stored encrypted in Supabase

**Legacy OAuth:**

1. Customer clicks "Standard OAuth"
2. Redirects to Facebook OAuth
3. User authorizes, returns with auth code
4. Backend exchanges for short-lived then long-lived token (60 days)
5. Backend queries existing WABA and phone number
6. Credentials stored encrypted in Supabase

Both flows coexist - Embedded Signup for new customers, OAuth for migrations.
