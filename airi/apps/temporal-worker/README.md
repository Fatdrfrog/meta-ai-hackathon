# Temporal Worker

This app is the dedicated Temporal worker runtime for Airi.

It is intentionally separate from `apps/web` so workflow execution, retries, and timers do not depend on the Next.js request lifecycle.

## What lives here

- Workflow runtime and worker bootstrap
- Durable per-conversation orchestration for Airi
- WhatsApp OTP API runtime for Google-hosted request/rate-limit handling
- WhatsApp OTP Pub/Sub delivery worker runtime
- Future activities for reply execution, media waits, retries, and recovery

## Shared contracts

Workflow names, task queue names, workflow ids, and payload shapes live in [`@icecore/temporal`](../../packages/temporal).

## Environment loading

The worker looks for env files in this order:

1. `apps/temporal-worker/.env.local`
2. `apps/temporal-worker/.env`
3. `apps/web/.env.local`
4. repo root `.env.local`
5. repo root `.env`

That lets you reuse the existing Temporal Cloud values already stored in `apps/web/.env.local` while onboarding.

## Start commands

Install dependencies from the repo root first, then:

```bash
pnpm dev:temporal-worker
```

Or run once without watch:

```bash
pnpm --filter @icecore/temporal-worker start
```

## WhatsApp OTP API mode

The same image can run an HTTP OTP API service for WhatsApp OTP request
creation. This is intended for Cloud Run with private Memorystore for Valkey
access.

Local example:

```bash
OTP_API_DISABLE_AUTH=true pnpm --filter @icecore/temporal-worker start:otp-api
```

Production uses `AIRI_RUNTIME_MODE=otp-api` with:

- `MEMORYSTORE_VALKEY_HOST`
- `MEMORYSTORE_VALKEY_PORT` (defaults to `6379`)
- existing `AI_GATEWAY_VERCEL_OIDC_*` auth settings
- existing Mongo/Supabase/encryption secrets

The GitHub deployment workflow only deploys the OTP API when repository
variable `GCP_OTP_API_ENABLED=true`. Normal deploys resolve an existing
Memorystore for Valkey instance; they do not create billable GCP infrastructure.
For a one-off bootstrap run, trigger the workflow manually with
`bootstrap_infra=true` and keep `GCP_VALKEY_CREATE_IF_MISSING=true` only for a
deployer identity that is allowed to create Memorystore instances.

## WhatsApp OTP delivery consumer

Production runs the OTP Pub/Sub consumer inside the main Temporal worker,
reusing its auxiliary-consumer startup, rollback, and shutdown lifecycle.
After the new worker finishes startup and live history verification, the
deployment scales any legacy standalone OTP pool to zero. Its revision remains
available for rollback, and normal releases do not deploy another OTP pool.

The main worker receives the existing `WHATSAPP_OTP_PUBSUB_*` configuration
listed below and the optional `OTP_HASH_SECRET`. The main worker service account
owns access to the delivery subscription.

### Standalone OTP mode for rollback and local development

The same image can run a dedicated Google Pub/Sub consumer for WhatsApp OTP
delivery. It does not start Temporal workflow polling.

Local example:

```bash
pnpm --filter @icecore/temporal-worker start:otp-worker
```

Production uses `AIRI_RUNTIME_MODE=otp-worker` with:

- `WHATSAPP_OTP_PUBSUB_ENABLED=true`
- `WHATSAPP_OTP_PUBSUB_PROJECT_ID`
- `WHATSAPP_OTP_PUBSUB_TOPIC`
- `WHATSAPP_OTP_PUBSUB_SUBSCRIPTION`
- `WHATSAPP_OTP_PUBSUB_MAX_MESSAGES`

## AI Gateway mode

The same app can also run an HTTP AI gateway for embedding generation and selected
search calls behind Google Cloud.

Local example:

```bash
AIRI_RUNTIME_MODE=ai-gateway AI_GATEWAY_DISABLE_AUTH=true pnpm --filter @icecore/temporal-worker start
```

## Production deployment

GitHub Actions is the source of truth for Cloud Run runtime config.

- Runtime vars and secrets are declared in [`runtime-manifest.json`](../../.github/cloud-run/runtime-manifest.json).
- The manifest is runtime-specific: worker and gateway each declare their own env surface. There is no shared catch-all bucket anymore.
- Entries marked `optional` in the manifest are skipped when the corresponding GitHub variable or secret is unset.
- `TEMPORAL_TASK_QUEUE` and `TEMPORAL_WORKER_DEPLOYMENT_NAME` are also optional overrides. If unset, the worker falls back to the built-in queue routing and deployment name defaults from [`src/config.ts`](./src/config.ts).
- Worker tuning values such as `TEMPORAL_WORKER_VERSIONING_BEHAVIOR`, concurrency limits, cache size, and shutdown windows are optional overrides. If unset, the worker uses the defaults from [`src/config.ts`](./src/config.ts): `PINNED`, `true`, `32`, `8`, `8`, `4`, `128`, `30s`, `120s`.
- The deploy workflow syncs GitHub repository secrets into Google Secret Manager, then deploys:
  - the Cloud Run worker pool with `AIRI_RUNTIME_MODE=worker`
    (including the OTP Pub/Sub delivery consumer)
  - the Cloud Run OTP API service with `AIRI_RUNTIME_MODE=otp-api` when `GCP_OTP_API_ENABLED=true`
  - the Cloud Run AI gateway service with `AIRI_RUNTIME_MODE=ai-gateway`
- Worker allocation defaults to 2 vCPUs and 4 GiB per instance; existing
  `GCP_WORKER_CPU`, `GCP_WORKER_MEMORY`, and `GCP_WORKER_INSTANCES` repository
  variables remain the overrides. After a production canary, `GCP_WORKER_CPU=1`
  and `GCP_WORKER_MEMORY=2Gi` explicitly select the smaller allocation;
  production retains two instances.
- Valkey bootstrap uses the SLA-eligible `custom-pico` node type in
  cluster-disabled mode. Routine deploys resolve the existing instance and do
  not resize it; capacity changes remain explicit operator actions.
- The Cloud Run AI gateway must be public at the Cloud Run layer because the app itself enforces Vercel OIDC bearer-token checks. The workflow configures this with `--no-invoker-iam-check` and verifies the public auth boundary after deploy by expecting unauthenticated `POST /v1/embeddings/document` to return the app-level JSON `401 Missing bearer token`.
- Required Google Cloud APIs for this deployment are:
  - `run.googleapis.com`
  - `cloudbuild.googleapis.com`
  - `artifactregistry.googleapis.com`
  - `secretmanager.googleapis.com`
  - `iamcredentials.googleapis.com`
  - `aiplatform.googleapis.com`
  - `pubsub.googleapis.com`
  - `bigquery.googleapis.com`
  - `memorystore.googleapis.com` when the OTP API is enabled
  - `networkconnectivity.googleapis.com` when the OTP API uses private Valkey access
- Enable those APIs once manually as the project owner, or opt into workflow-managed enablement by setting GitHub repo variable `GCP_ENABLE_REQUIRED_APIS=true` and granting the GitHub deployer service account `Service Usage Admin`.
- The GitHub deployer service account still needs the permissions required for deployment and secret sync, including Secret Manager administration.
- If you do not want the GitHub deployer service account to manage Secret Manager contents, precreate the required secrets in Google Secret Manager and set GitHub repo variable `CLOUD_RUN_SKIP_SECRET_SYNC=1`. In that mode, the workflow references existing secrets but does not create or update them.
- `AI_GATEWAY_VERCEL_OIDC_ISSUER_URL`, `AI_GATEWAY_VERCEL_OIDC_AUDIENCE`, and `AI_GATEWAY_VERCEL_OIDC_SUBJECTS` belong on the Cloud Run AI gateway service, not in Vercel.
- `GCP_AI_GATEWAY_URL` and `REALTIME_GATEWAY_URL` belong in Vercel and local web env files, because the Next.js runtime calls the Cloud Run gateways. The deploy workflow syncs both values into Vercel after gateway health checks pass.
- Vertex embeddings are keyless in this architecture:
  - local development uses Google ADC
  - Cloud Run uses the attached service account
  - Vercel uses the Cloud Run AI gateway
- Platform text AI runs on Claude. The worker pool receives the
  `ANTHROPIC_API_KEY` GitHub repository secret as a Secret Manager reference,
  never as a plain env value, next to the existing `GEMINI_API_KEY` secret used
  for Google media features (the Vertex Gemini text fallback uses the service
  account). Like other optional secrets, it is referenced only
  when the workflow receives a value; with `CLOUD_RUN_SKIP_SECRET_SYNC=1`, also
  precreate the `ANTHROPIC_API_KEY` secret in Secret Manager. The AI gateway does
  no text generation and does not receive it.
- Optional repository variables `ANTHROPIC_LIGHT_MODEL`, `ANTHROPIC_HEAVY_MODEL`,
  `ANTHROPIC_REASONING_MODEL`, `ANTHROPIC_AI_ENABLED`, `ANTHROPIC_WORKSPACE_ID`
  (only for a key not scoped to a workspace), and
  `AI_CHAT_PROVIDER_ORDER` reach the worker. When set, the Vercel sync also
  writes them so web and worker select the same models; an unset variable never
  clears a Vercel value, so set the default explicitly to revert. The Vercel
  `ANTHROPIC_API_KEY` is managed in Vercel directly and is never synced.

### Worker image build cache and validation

[`Dockerfile`](./Dockerfile) installs Python media dependencies before copying
runtime source, then uses the pinned package manager and `pnpm fetch` with the
root lockfile and workspace configuration. The complete monorepo is still copied
for the worker's dynamic web imports; `pnpm install --offline --frozen-lockfile`
links those packages before building the workflow bundle. Source-only changes
therefore reuse dependency layers without maintaining a second list of workspace
manifests. Lockfile, workspace configuration, package manager, and media
requirements changes invalidate their respective dependency layers. Provider
SDKs used by web runtime code, such as `@google/genai` and `@anthropic-ai/sdk`,
are `apps/web` dependencies: the workspace install links them under
`apps/web/node_modules`, where the worker's web imports resolve them, so the
worker package does not declare them again.

[`cloudbuild.temporal-worker.yaml`](../../cloudbuild.temporal-worker.yaml) pulls
the same Artifact Registry image's `build-cache` tag and exports BuildKit inline
cache metadata for the next build. A missing cache or a failed cache upload is
logged and does not block a valid release. A failed image build or immutable
release upload still fails the deployment. All Cloud Run runtimes continue to
receive the immutable build-specific image tag; `build-cache` is only a build
input. The first build populates the cache, so production build-time savings
must be measured after subsequent releases. To force dependency and media model
refreshes, delete the `build-cache` tag before a release.

Deployment validation installs Temporal CLI before running the complete worker
test suite, because local workflow integration tests start its development
server. That same installation is reused for promotion. Replay, startup-import,
readiness, and exact-build promotion gates remain required, and production worker
releases remain serialized.

### Vercel build settings

The web and widget projects use `apps/web` and `apps/widget` as their respective
Root Directories, with files outside the root included for workspace dependencies.
Both projects enable **Skip deployments when there are no changes to the root
directory or its dependencies**, use the **Standard** build machine, and queue
at most one build per branch at a time. These settings reduce unnecessary and
overlapping builds while keeping pull request previews. Vercel treats global
workspace files as affecting every project, so a shared lockfile or workspace
configuration change can still build both apps.

Each project's `vercel.json` installs with a frozen lockfile and its pnpm
workspace filter (`@icecore/web...` or `@icecore/widget...`), retaining transitive
dependencies while avoiding installation of unrelated apps.

The web project's automatic `main` deployment remains disabled; the guarded
Deploy Web workflow owns web production. Actual build-time and cost savings
remain unmeasured until releases use these settings.

### Deploy order: web after worker

Web production must never run ahead of the worker that executes it. Vercel
therefore does not auto-deploy `main` (`apps/web/vercel.json` sets
`git.deploymentEnabled.main` to `false`); pull request previews and the widget
project still deploy from Vercel. [Deploy Web](../../.github/workflows/deploy-web.yml)
creates every web production deployment with
`.github/scripts/deploy-vercel-production.mjs`:

- The worker paths are the `on.push.paths` list of `deploy-temporal-worker.yml`,
  nothing else. A web commit is covered when the two-dot diff from the latest
  successful push-triggered worker rollout to that commit touches none of them.
- Covered pushes to `main` deploy when the complete diff from the currently
  serving production SHA changes web build inputs. These inputs come from
  `apps/web`, its transitive workspace dependencies declared in package
  manifests, root configuration and lockfiles, `patches/**`, `supabase/**`, and
  the production Supabase prebuild contract. Root files other than documentation
  are checked conservatively. Docs, unrelated apps or packages, and worker-only
  source changes can skip a Vercel rebuild on push; pending web changes in
  earlier commits are still included. Older covered candidates use a conservative
  input check when later package manifests changed dependency ownership. A push
  requiring a web build is deferred if it contains worker changes whose rollout
  is still pending or failed.
- When Deploy Temporal Worker succeeds for a push, web deploys that exact commit,
  or the newest later `main` commit whose changes since it are outside the
  worker paths, even when web source inputs did not change. Every successful
  worker rollout synchronizes Vercel build environment values, whose freshness
  cannot be proved from a source diff; a new deployment materializes those values.
  A later worker-path commit waits for its own rollout.
- When the worker run fails or is cancelled, nothing is deployed and the worker
  run summary says so. Manual worker runs never deploy web by themselves.
- The target must be strictly newer than the commit production serves, checked
  before the build and again just before promotion. Same or older commits are skipped and logged; a production
  commit outside `main`'s history fails the run.
- The build is created from `gitSource` (`main` plus the exact SHA) as a staged
  production deployment and promoted after `READY`, with the same guarded
  promotion as `redeploy_web`. `ERROR`, `CANCELED`, `BLOCKED` and a 30-minute
  timeout fail the run.
- When available, the stable GitHub repository ID identifies the source and
  must match the Vercel project's linked repository before a deployment is
  created; other callers retain the organization and repository-name fallback.
  Provider failures include bounded, redacted error codes and messages for
  diagnosis.
- The Deploy Web `deploy` job and `redeploy_web` share the `deploy-web-prod`
  concurrency group. A newer queued deploy can replace a pending one and
  recomputes the target.
- While Vercel's automatic production domain assignment is off, for example
  after an Instant Rollback, CI does not promote, because that would undo the
  rollback. Undo the rollback in Vercel to resume.

To deploy one exact `main` commit manually, for example after a failed worker
run once the worker is known good, or after a manual worker deploy:

```bash
gh workflow run deploy-web.yml --ref main -f sha=<full 40-character main commit SHA>
```

This skips the worker check but still never replaces a newer production commit.
`redeploy_web` rebuilds an existing production deployment of the current `main`
commit, which is how Vercel env changes reach a commit production already serves. Deploy Web needs the `VERCEL_TOKEN` secret and the Vercel
project and team variables listed below; it runs on GitHub-hosted runners so it
never waits behind a worker deploy on `DEPLOY_RUNS_ON`.

### Conversation classification Pub/Sub rollout

The web runtime and Temporal worker both publish canonical classification
events to `icecore-conversation-classification-events`. The existing worker pool
consumes `icecore-conversation-classification-events-worker`; no separate worker
pool is deployed. Its five runtime variables are:

- `CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED` (defaults to `false`)
- `CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID`
- `CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC`
- `CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION`
- `CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES`

The deploy workflow provisions and then verifies the topic, worker subscription,
DLQ topic, and DLQ subscription. It also verifies five unconditioned,
resource-level IAM bindings: DLQ publisher and subscriber bindings for the
Google-managed Pub/Sub service agent, worker subscription access for
`GCP_WORKER_SERVICE_ACCOUNT`, and topic publisher access for both
`GCP_SERVICE_ACCOUNT_EMAIL` and `GCP_WORKER_SERVICE_ACCOUNT`. The two service
account repository variables are required; the workflow does not infer a
project-wide role or replacement identity.

Repository variables may override the four resource names with
`CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC`,
`CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION`,
`CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_TOPIC`, and
`CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_SUBSCRIPTION`. Keep the topic override
identical for Cloud Run and Vercel. `CONVERSATION_CLASSIFICATION_PUBSUB_SKIP_SETUP=1`
suppresses creation only after the exact topology verifies, and
`CONVERSATION_CLASSIFICATION_PUBSUB_SKIP_IAM_BINDINGS=1` suppresses IAM mutation
only after all five unconditioned bindings verify.

Publishing and reconciliation are enabled by checked-in literals:
`CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED=true` in the worker pool env and
the Vercel sync, and `CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED=true` in
the Vercel sync. The sync does not read a possibly stale repository variable for
these gates, and a Vercel-only change is not durable because a later worker
deployment reasserts the checked-in release state. The worker consumer stays
behind the `CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED` repository variable.

Turn the consumer on before or together with publishing. Reconciliation
republishes the oldest 200 due conversations every five minutes until a consumer
moves them out of `pending`, so publishing without a consumer only queues
repeated wakes. The worker subscription is created with
`--expiration-period=never` (`--never-expire`), so an idle consumer no longer
lets Pub/Sub delete it after 31 days.

Required GitHub repository variables for the gateway include:

- `AI_GATEWAY_VERCEL_OIDC_ISSUER_URL`
- `AI_GATEWAY_VERCEL_OIDC_AUDIENCE`
- `AI_GATEWAY_VERCEL_OIDC_SUBJECTS`

Required GitHub repository secrets for syncing web runtime gateway URLs:

- `VERCEL_TOKEN`

Optional GitHub repository variables for the gateway include:

- `GCP_AI_GATEWAY_SERVICE_NAME`
  If unset, the deploy workflow defaults to `airi-ai-gateway`.
- `VERCEL_PROJECT_ID` or `VERCEL_PROJECT_NAME`
  If unset, the Vercel sync step derives the project from `AI_GATEWAY_VERCEL_OIDC_SUBJECTS`.
- `VERCEL_TEAM_ID` or `VERCEL_TEAM_SLUG`
  If unset, the Vercel sync step derives the team slug from `AI_GATEWAY_VERCEL_OIDC_AUDIENCE` or `AI_GATEWAY_VERCEL_OIDC_ISSUER_URL`.
- `VERCEL_ENV_TARGETS`
  Comma-separated Vercel env targets for gateway URL sync. Defaults to `production`.

### LLM product analytics infrastructure

`.github/scripts/sync-gcp-llm-product-analytics.mjs` is the single owner of the
BigQuery and Pub/Sub product-ledger topology. Routine worker deployments only
validate the prepared topology (`validate`) or the finalized compatibility
views (`validate-finalized`); they do not create resources or grant IAM.

The GitHub deploy identity intentionally has no BigQuery DDL authority. An
authorized operator creates missing analytics infrastructure by running this
script from the repository root. Substitute the project and deployed publisher
service-account values:

```bash
node .github/scripts/sync-gcp-llm-product-analytics.mjs \\
  --phase prepare \\
  --project "<gcp-project-id>" \\
  --publisher-service-account "<gateway-service-account>" \\
  --publisher-service-account "<worker-service-account>"
```

Repeat `--publisher-service-account` for every distinct deployed publisher
identity; the gateway and worker may share one identity, in which case provide
it once. The default BigQuery location is `US`; only when the existing dataset
uses another location, set `GCP_LLM_ANALYTICS_LOCATION` to that location before
running either command.

To complete the compatibility-view cutover, first detach legacy subscriptions,
then run:

```bash
node .github/scripts/sync-gcp-llm-product-analytics.mjs \\
  --phase finalize \\
  --project "<gcp-project-id>" \\
  --publisher-service-account "<gateway-service-account>" \\
  --publisher-service-account "<worker-service-account>"
```

Any subscription still attached to a legacy topic fails closed. The script
validates prerequisites immediately before mutation and validates the finalized
state afterward. The
workflow's `bootstrap_infra` input continues to own other gated resources; it
does not grant analytics mutation authority.

### WhatsApp feedback prompts

- `LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED` (worker runtime — Airi outbound delivery)
- `LLM_WHATSAPP_FEEDBACK_TESTERS` (comma-separated waIds; worker runtime)

WhatsApp feedback prompts are sent from the Temporal worker after a real Meta
send; setting these only on Vercel is not enough.

## WhatsApp Calls Runtime

WhatsApp call control is durable through the Temporal worker. Calling webhooks
are routed to a dedicated Pub/Sub topic so call lifecycle events are not blocked
behind generic message webhook backlog. Media setup is optional and remains
limited to Full Cloud Embedded Signup sources with Meta phone calling enabled;
coexistence sources do not auto-prepare media.

Production worker variables:

- `WHATSAPP_CALL_PUBSUB_ENABLED`
- `WHATSAPP_CALL_PUBSUB_PROJECT_ID`
- `WHATSAPP_CALL_PUBSUB_TOPIC`
- `WHATSAPP_CALL_PUBSUB_SUBSCRIPTION`
- `WHATSAPP_CALL_PUBSUB_MAX_MESSAGES`
- `WHATSAPP_CALL_COMMAND_TIMEOUT_SECONDS`
- `WHATSAPP_CALL_RECORDING_BUCKET`
- `WHATSAPP_CALL_RECORDING_EGRESS_ENABLED`
- `WHATSAPP_CALL_RECORDING_FILE_TYPE`
- `WHATSAPP_CALL_RECORDING_RETENTION_DAYS`
- `WHATSAPP_CALL_RECORDING_PIPELINE_ENABLED`
- `WHATSAPP_CALL_RECORDING_PIPELINE_URL`
- `WHATSAPP_CALL_RECORDING_WEBHOOK_URL`
- `WHATSAPP_CALL_TRANSCRIPTION_ENABLED`
- `WHATSAPP_CALL_TRANSCRIPTION_PROJECT_ID`
- `WHATSAPP_CALL_TRANSCRIPTION_LOCATION`
- `WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES`
- `WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE`
- `WHATSAPP_CALL_TRANSCRIPTION_MODEL`
- `WHATSAPP_CALL_TRANSCRIPTION_RECOGNIZER`
- `WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ENABLED`
- `WHATSAPP_CALL_TRANSCRIPTION_DRAIN_LIMIT`
- `WHATSAPP_CALL_ANALYTICS_ENABLED`
- `WHATSAPP_CALL_ANALYTICS_PROJECT_ID`
- `WHATSAPP_CALL_ANALYTICS_TOPIC`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_EGRESS_GCP_CREDENTIALS_JSON`
- `LIVEKIT_EGRESS_TOKEN_TTL_SECONDS`
- `WHATSAPP_CALL_TRANSCRIPTION_SERVICE_ACCOUNT_JSON`
- `LIVEKIT_WHATSAPP_CLOUD_API_VERSION` (optional, defaults to `24.0`)
- `LIVEKIT_MEDIA_TOKEN_TTL_SECONDS`

The Next.js web runtime also needs `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, and optionally `LIVEKIT_MEDIA_TOKEN_TTL_SECONDS` so the
call panel can mint short-lived operator media tokens.

LiveKit Cloud is the media transport for WhatsApp calls. Voice bots remain on
ElevenLabs; do not route voice-bot generation through LiveKit agents unless the
product explicitly changes that vendor boundary.

The media-prep activity calls the LiveKit Connector API directly with
`whatsappPhoneNumberId`, source access token as `whatsappApiKey`,
`whatsappCloudApiVersion`, `whatsappCallId`, and SDP. When LiveKit returns
`roomName`, the workflow treats the call as connector-accepted and does not
issue the older Meta pre-accept command.

When `WHATSAPP_CALL_RECORDING_EGRESS_ENABLED=true`, the call workflow starts a
LiveKit `StartRoomCompositeEgress` request after media preparation and writes
audio-only output to `WHATSAPP_CALL_RECORDING_BUCKET` using
`LIVEKIT_EGRESS_GCP_CREDENTIALS_JSON`. Terminal finalization stops the saved
egress id when present and records the stop status.

When `WHATSAPP_CALL_TRANSCRIPTION_ENABLED=true` and no external recording
pipeline accepted the job, terminal finalization submits a Google Speech-to-Text
v2 `batchRecognize` request for the recorded GCS object. Configure
`WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES` with explicit BCP-47 language codes
such as `kk-KZ,en-US`; `und` is intentionally not accepted for direct Speech
dispatch. The worker uses Cloud Run metadata credentials by default, or
`WHATSAPP_CALL_TRANSCRIPTION_SERVICE_ACCOUNT_JSON` when supplied. The call
workflow stores the returned operation name and a scheduled Temporal drain polls
processing recordings in bounded batches until Google reports `completed` or
`failed`. Use `WHATSAPP_CALL_TRANSCRIPTION_DRAIN_LIMIT` to tune per-run batch
size; the schedule is enabled by default and can be disabled with
`WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ENABLED=false`.

When `WHATSAPP_CALL_RECORDING_PIPELINE_ENABLED=true`, the terminal call workflow
also posts an idempotent request to the transcription/finalization pipeline.
Set `WHATSAPP_CALL_RECORDING_PIPELINE_URL` explicitly when enabling that path.
Pipeline requests include a stable idempotency key so Temporal retries do not
create duplicate transcription jobs. The web runtime must also have
`WHATSAPP_CALL_RECORDING_WEBHOOK_SECRET`; the pipeline sends that value as
`x-airi-webhook-secret` when posting transcript completion to
`/api/webhooks/whatsapp/call-recording`.

## Workspace Usage Counters

Workspace/company limit reads are served from Supabase usage snapshots, with
Valkey/Upstash as a short TTL cache only. Mongo remains the operational source
of truth, but panel `/limits` requests must not run live Mongo counts.

Hot mutation paths publish compact usage events to Pub/Sub. The worker consumes
those events in batches, applies idempotent Supabase counter increments, updates
snapshots, and invalidates the snapshot cache. Temporal is used for daily repair
and manual backfill, not for one workflow per usage event.

Production worker variables:

- `WORKSPACE_USAGE_PUBSUB_ENABLED`
- `WORKSPACE_USAGE_PUBSUB_PROJECT_ID`
- `WORKSPACE_USAGE_PUBSUB_TOPIC`
- `WORKSPACE_USAGE_PUBSUB_SUBSCRIPTION`
- `WORKSPACE_USAGE_PUBSUB_MAX_MESSAGES`
- `WORKSPACE_USAGE_PUBSUB_BATCH_SIZE`
- `WORKSPACE_USAGE_PUBSUB_FLUSH_MS`
- `WORKSPACE_USAGE_REPAIR_SCHEDULE_ENABLED`
- `WORKSPACE_USAGE_REPAIR_LIMIT`

Initialize or repair snapshots manually with:

```bash
pnpm --filter @icecore/temporal-worker backfill:usage-snapshots -- --limit=250
```

For analytics reporting, create the raw BigQuery event sink and typed view from
[`docs/workspace-usage-bigquery.sql`](../../docs/workspace-usage-bigquery.sql),
then create the documented Pub/Sub BigQuery subscription on the same
`icecore-workspace-usage-events` topic. BigQuery is append-only reporting; it is
not used for product enforcement reads.

`AI_GATEWAY_VERCEL_OIDC_*` values come from Vercel OIDC:

- Issuer: `https://oidc.vercel.com/[TEAM_SLUG]` in team issuer mode, or `https://oidc.vercel.com` in global issuer mode
- Audience: `https://vercel.com/[TEAM_SLUG]`
- Subject: `owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]`
