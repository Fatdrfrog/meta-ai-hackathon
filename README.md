# meta-ai-hackathon

Film it, sell it: a shop films its showroom once, and an AI seller on WhatsApp knows every product on the shelf.

Our entry to the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startup track, from the team behind [airi.chat](https://airi.chat).

- [docs/architecture.md](docs/architecture.md): how it works, which Meta models do what, and where the work lives
- [HACKATHON.md](HACKATHON.md): how to tell what was built during the hackathon
- `airi/`: airi.chat, our existing product, imported as pre-existing code. The hackathon's product work happens inside it, in later commits that HACKATHON.md lists. It is a separate pnpm workspace

## Status

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
- **Videos sent on WhatsApp:** link your phone once by scanning a code on the Products page (a number already connected to the workspace counts as linked), then send shelf videos to Airi's number. Their products appear in airi, and Airi writes back once with the link to check them.

**Prototype** (root):

- **Studio:** the owner uploads a video, watches the shelf being built, fixes names and prices, and confirms products.
- **Shop page:** buyers see the confirmed products with their price tags and chat with the AI seller, an agent on Muse Spark Open that searches the shelf, matches photos, shows product cards, and places and looks up orders. Orders and questions it can't answer reach the studio.

## Run the prototype

```bash
pnpm shop:create "QazOner Group"   # prints the owner's studio link and the shop page link
pnpm dev                            # server on :8787, studio and shop on http://localhost:5173
```

Data (the SQLite database, uploaded videos, cut-outs) lives in `.data/app/`, which git ignores.

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
