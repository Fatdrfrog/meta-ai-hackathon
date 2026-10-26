# meta-ai-hackathon

Film it, sell it: a shop films its showroom once, and an AI seller on WhatsApp knows every product on the shelf.

Our entry to the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startup track, from the team behind [airi.chat](https://airi.chat).

- [docs/architecture.md](docs/architecture.md): how it works, which Meta models do what, and how it stays separate from airi.chat
- [HACKATHON.md](HACKATHON.md): how to tell what was built during the hackathon

## Status

Day 1: the Meta Model API client, the spend cap and the first experiments on a real shop video.

## Setup

Requires Node.js 24, pnpm 11 and ffmpeg.

```bash
pnpm install
cp .env.example .env
git config core.hooksPath .githooks
```

Put your Meta Model API key in `.env`. Every commit subject starts with `meta-ai-hackathon: `.

## Run the experiments

```bash
pnpm spike:video path/to/shop-video.mp4
pnpm spike:sam path/to/shop-video.mp4 "medal" --file-id=<id printed by spike:video>
```

The first lists the products Muse Spark sees and hears in the video. The second tracks one kind of product with SAM 3.1 and saves a cut-out of each item. Results go to `.data/spikes/`, which git ignores.

## Checks

```bash
pnpm typecheck
pnpm test
```

## License

[Apache-2.0](LICENSE)
