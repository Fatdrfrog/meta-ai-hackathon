# meta-ai-hackathon

Film it, sell it: a shop films its shelf once, saying the prices, and gets a catalog to sell from on WhatsApp: a clean photo and a name for every product, and every spoken price shown with the words it came from, which code finds word for word in the narration. Meta's models find the products and make their photos; ElevenLabs Scribe writes down the narration.

Our entry to the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startup track, from the team behind [airi.chat](https://airi.chat).

**Theme: Build for Your World.** The small shops we work with at airi.chat sell on WhatsApp and have no product photos.

- [docs/architecture.md](docs/architecture.md): how it works, which Meta models do what, and where the work lives
- [HACKATHON.md](HACKATHON.md): what was built during the hackathon and what existed before, the Meta models used, and how to try it
- `airi/`: airi.chat, our existing product, imported as pre-existing code. The hackathon's product work happens inside it, in later commits that HACKATHON.md lists. It is a separate pnpm workspace

## Status

**Live:** the Products section has run in production on [airi.chat](https://airi.chat) since October 29, 2026, behind the `products` flag, which is turned on per workspace. Its first import there, our own test on October 30, stopped after 2 of its 5 photos; the fix, which makes each photo its own AI action, went live on November 1. Access for judges is in our submission form, and [HACKATHON.md](HACKATHON.md#try-it) says what to try. HACKATHON.md also lists every hackathon commit that built a feature, links the full history, and says what existed before.

On October 27 the project moved inside airi.chat, where shop owners already run their WhatsApp number. The standalone prototype at the root stays as the experiments and the first working version.

**Inside airi.chat** (`airi/`):

- **Products section** for workspace admins: products shown as cut-outs standing on a shelf.
- **Meta Model API client:** Muse Spark, Muse Image and SAM 3.1, with timeouts, retries and the cost of every call.
- **Video-to-products pipeline:** on the 65-second test video, all 7 products found with the right spoken prices, and all 7 photos restored by Muse Image (the owner's hand removed, the product upright on a plain backdrop, then cut out), in about 2.5 minutes for $0.36.
- **Import job:** a Temporal workflow runs the pipeline for each uploaded video, saves every step so a retry resumes without paying again, counts its model calls against the workspace's AI spend limit, and shows products live as they arrive.
- **Products as the shop sells them:** a product is one name at one price, said or written on screen, and every item shown for it (several designs, sizes or shapes, or the panels and clocks of one sentence) is one of its options, with its own photo. The shelf shows the featured option.
- **Videos that don't follow the brief:** owners don't always film the way they're asked. An edited promo with cuts, a presenter, subtitles and price stickers works too: tracking never crosses a cut, Muse checks every crop shows the product before it's restored, subtitles, people and neighbouring items are removed, a product filmed at a slant is levelled to horizontal or vertical, ends the frame cut off are completed to match, a buyer's name hidden under a sticker becomes a default name the owner is told about, the background shows through holes and openwork, prices only written on screen and "from" prices are read and flagged, and the person presenting is kept as a cut-out, without the subtitles over them, to reuse later.
- **Upload on the Products page:** choose or drop a video; it goes straight to storage with its progress shown, after the page checks it's a video of 5 minutes at most. Then the page follows the import live: each stage, and the products it finds landing on a dashed shelf as their photos are made. It also shows imports started elsewhere, and why one failed.
- **Swipe-through review:** one card per product, with a round clip of the owner saying its price. What Airi isn't sure of is in red with why. Swipe right (or →) to add it to the shelf, left (or ←) to skip, undo, or accept all; tap the name or price to fix it, or choose which item the shelf shows.
- **WhatsApp drafts:** after the review, one tap makes a carousel template (the products on white cards, opened in airi's template editor to send to Meta) or an order form (saved on WhatsApp as a draft Flow to publish), both written for buyers in the language the owner spoke.
- **Videos sent on WhatsApp:** link your phone once from "Send from WhatsApp" on the Products page: scan the QR, send the message it writes (it names the shop and holds nothing secret), and confirm the phone on the page. A number already connected to the workspace counts as linked. Then send shelf videos to Airi's number. Their products appear in airi, and Airi writes back once per video with the link to check them.
- **Each photo its own AI action:** our first test import in production stopped after 2 of 5 photos, because the whole video was one AI action under the $0.50 cap on an action. Now reading the video is one action and each photo another, at honest prices. If the company's AI allowance runs out partway, the import still ends with every product it found and says how many photos weren't made.
- **A stage that shows the models at work:** while a video is imported, a rail names who does each step (ElevenLabs Scribe v2 listens, Muse Spark 1.3 watches, Muse Spark, SAM 3.1 and Muse Image 1.0 make the photos, the owner checks), and each photo lifts off the frame it was filmed in, with the owner's words for its price. The products then stand on a shelf drawn like a real one.

**Prototype** (root), not part of airi.chat; it runs locally:

- **Studio:** the owner uploads a video, watches the shelf being built, fixes names and prices, and confirms products.
- **Shop page:** buyers see the confirmed products with their price tags and chat with the AI seller, an agent on Muse Spark Open that searches the shelf, matches photos, shows product cards, and places and looks up orders. Orders and questions it can't answer reach the studio.

## Run the prototype

After [Setup](#setup):

```bash
pnpm shop:create "QazOner Group"   # prints the owner's studio link and the shop page link
pnpm dev                            # server on :8787, studio and shop on http://localhost:5173
```

In the studio, upload a shelf video and confirm the products it finds. The shop page then shows them, with the AI seller in its chat; the chat is off without a Baseten key.

Data (the SQLite database, uploaded videos, cut-outs) lives in `.data/app/`, which git ignores.

## Setup

Requires Node.js 24, pnpm 11 and ffmpeg.

```bash
pnpm install
cp .env.example .env
git config core.hooksPath .githooks
```

Put your keys in `.env`: the Meta Model API key, an ElevenLabs key for speech, and a Baseten key for the AI seller on Muse Spark Open. Without Baseten's hackathon approval, set `BASETEN_MODEL=meta-models/muse-spark-open` in `.env`: the hackathon ID it ships with, `meta-models/muse-spark-open-1026`, answers 404 until Baseten approves your account. Every commit subject starts with `meta-ai-hackathon: `.

## Build a catalog from a video

```bash
pnpm catalog path/to/shop-video.mp4
```

Prints the transcript and every product with its price and the words the price came from, and writes cut-outs and a contact sheet to `.data/catalogs/`, which git ignores.

## Check the AI seller

```bash
pnpm seller:eval   # scripted buyer conversations against the latest catalog, each reply checked in code
```

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

CI also checks the hackathon's code inside airi.chat: the `airi` job in [.github/workflows/ci.yml](.github/workflows/ci.yml).

## License

[Apache-2.0](LICENSE)
