# meta-ai-hackathon

Film it, sell it: a shop films its showroom once, and an AI seller on WhatsApp knows every product on the shelf.

Our entry to the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startup track, from the team behind [airi.chat](https://airi.chat).

- [docs/architecture.md](docs/architecture.md): how it works, which Meta models do what, and how it stays separate from airi.chat
- [HACKATHON.md](HACKATHON.md): how to tell what was built during the hackathon

## Status

The video-to-catalog pipeline works end to end: on a 65-second test video, all 7 products cut out and all 7 spoken prices right, in about a minute for $0.07. The owner's studio is next.

## Setup

Requires Node.js 24, pnpm 11 and ffmpeg.

```bash
pnpm install
cp .env.example .env
git config core.hooksPath .githooks
```

Put your keys in `.env`: the Meta Model API key, and an ElevenLabs key for speech. Every commit subject starts with `meta-ai-hackathon: `.

## Build a catalog from a video

```bash
pnpm catalog path/to/shop-video.mp4
```

Prints the transcript and every product with its price and the words the price came from, and writes cut-outs and a contact sheet to `.data/catalogs/`, which git ignores.

## Experiments

```bash
pnpm spike:speech path/to/video.mp4 --expect=prices.json   # score speech models against real prices
pnpm spike:sam path/to/video.mp4 "medal"                   # track one kind of product through a video
```

What the experiments found is in [docs/findings.md](docs/findings.md).

## Checks

```bash
pnpm typecheck
pnpm test
```

## License

[Apache-2.0](LICENSE)
