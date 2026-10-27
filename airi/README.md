# airi.chat

airi.chat is a WhatsApp-first customer engagement platform for official
campaigns, approved templates, Flows, automations, customer lists, analytics,
and AI-assisted follow-ups across customer channels.

## Apps and packages

- `apps/web`: Main Next.js app for the airi.chat SaaS
- `apps/widget`: Web widget embedded on customer sites
- `apps/mobile`: Expo Router companion app
- `apps/temporal-worker`: Temporal worker, AI gateway, media API, realtime,
  and WhatsApp OTP runtimes
- `packages/shared`: Shared utilities, types, constants, and low-level helpers
- `packages/temporal`: Shared Temporal workflow and activity contracts
- `packages/scenario-contracts`: Scenario and campaign payload contracts
- `packages/airi-runtime`: Runtime helpers reused by web and worker paths
- `packages/otp-runtime`: Shared WhatsApp OTP runtime helpers
- `packages/whatsapp`: Shared WhatsApp domain helpers

## Getting started

1. Use Node.js 24 and the pnpm version pinned in `package.json`, then install
   dependencies:
   - `pnpm install`
2. Configure environment variables:
   - Create `apps/web/.env.local` using the
     [web local setup guide](apps/web/README.md#local-setup)
   - Copy `apps/widget/.env.example` to `apps/widget/.env.local`
   - Copy `apps/mobile/.env.example` to `apps/mobile/.env.local` when working
     on the mobile app
   - Copy `apps/temporal-worker/.env.example` to
     `apps/temporal-worker/.env.local` when working on the worker; it also
     loads shared values from `apps/web/.env.local`
3. Start the runtime you need: `pnpm dev:web`, `pnpm dev:widget`,
   `pnpm dev:mobile`, or `pnpm dev:temporal-worker`. `pnpm dev` starts all
   available workspace dev tasks.

More maintainer-oriented commands live in [AGENTS.md](./AGENTS.md).

## Production classification events

Conversation classification uses a shared Google Pub/Sub topic for both the
Vercel web runtime and the existing Temporal worker pool. Deployment owns the
exact topic/subscription/DLQ topology and resource-level IAM checks; it does not
create a separate classification worker pool. Both consumption and the web
reconciliation route deploy disabled by default. See
[apps/temporal-worker/README.md](./apps/temporal-worker/README.md#conversation-classification-pubsub-rollout)
for resource names, required identities, skip-mode verification, and rollout
gates.

## Open source

The source code in this repository is available under Apache-2.0. The hosted
airi.chat service, production data, operational secrets, billing relationships,
and trademarks are not granted by the code license.

Before making the GitHub repository public, rotate production credentials if
they were ever shared outside the secret managers, and verify that deployment
workflows cannot expose production resources to untrusted forks.

## Security

See [SECURITY.md](./SECURITY.md). Please report suspected vulnerabilities
privately instead of opening a public issue.

## License

Apache-2.0. See [LICENSE](./LICENSE).
