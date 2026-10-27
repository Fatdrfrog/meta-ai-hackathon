# Architecture

A shop films its products once. Meta's models turn the video into a catalog of clean product photos and prices, and the shop sells from it on WhatsApp.

## Where the work lives

The project started as a standalone prototype and, on October 27, moved inside [airi.chat](https://airi.chat), our existing WhatsApp product. Shop owners already run their business number in airi.chat, so the video import is a new section there instead of a second app they would have to adopt. [HACKATHON.md](../HACKATHON.md) lists every commit and says what existed before.

| | Where | What it is |
| --- | --- | --- |
| Prototype | `apps/`, `packages/`, `scripts/` at the root | Written during the hackathon. The experiments behind [findings.md](findings.md), the first pipeline, a studio and shop page, and the AI seller on Muse Spark Open. It runs on its own from this repository. |
| Product | `airi/` | airi.chat, imported as pre-existing code. Hackathon work inside it arrives only in later commits, each listed in HACKATHON.md: the Products section, the Meta Model API client and the video-to-products pipeline so far. |

## Who uses what

| Who | Where | What they do |
| --- | --- | --- |
| Shop owner | **Products**, a section of airi.chat for workspace admins | Film the shelf, check the products Airi found (swipe through them, or accept all), publish them, and turn them into WhatsApp carousel and order-form drafts |
| Buyer | **WhatsApp**, on the shop's own number, connected to airi.chat | See products in carousels, ask, order |
| Judges | The prototype's **web chat** | The AI seller from the prototype, without needing a phone number |

Built so far in airi.chat: the Products section, the Meta Model API client and the pipeline. Uploading from the Products page, the review, the WhatsApp drafts and sending a video to Airi on WhatsApp come next, in that order.

The owner never makes decisions inside WhatsApp. Since October 1, 2026, Meta bills every service message after the first 1,000 per number each month, so a review dialogue in chat would cost money on every tap. The Products section does the same job for free.

## Message costs

Every AI reply to a buyer is a paid message once the free 1,000 are used up, so the selling side is built to spend as few as possible:

- One rich reply per buyer turn: a carousel shows up to 10 products in a single message.
- No "thinking…" or acknowledgement messages.
- Messages per order is tracked as a cost metric.
- Buyers arriving from Click-to-WhatsApp ads are free for 72 hours.

## Pipeline

```
shop video ──► normalize (ffmpeg) ──┬─► audio ──► Scribe: timestamped transcript ──┐
                                    └─► silent video ──────────────────────────────┴─► Muse Spark: products, prices
                                                                                       (checked word for word against
                                                                                       the transcript), doubts, moments
                                                                                                │
   per product: Muse picks a frame + box ──► SAM 3.1 tracks it ──► best measured frame ──► crop ◄┘
                                                                                             │
       Muse Image restores what the hand hid, upright on white ──► SAM 3.1 cuts it out ──► Muse Spark: same product?
                                                                                             │
                                          products with photos, for the owner to check and publish in airi.chat
```

In airi.chat the pipeline is in the Temporal worker, `airi/apps/temporal-worker/src/media/product-video/`. On the 7-product test video it found all 7 products with the right prices and restored all 7 photos, in about 2.5 minutes for $0.36 of Meta calls.

## Models

| Model | Job | Notes |
| --- | --- | --- |
| Muse Spark 1.3 | Watch the silent shop video with the owner's transcript as text; list products, prices, doubts, and each product's clearest moment and search phrase | MP4 input only; about $0.045 per minute of video |
| Muse Spark 1.3 (vision) | Per product: pick the clearest of 8 frames and draw a box around it; afterwards, check the restored photo still shows the same product | Three image calls per product |
| SAM 3.1 | Track that box through the product's clip at 10 fps, so the best frame is chosen by measuring its mask; cut the restored product out of Muse Image's white background | About $0.02 per product |
| Muse Image 1.0 | Restore what the owner's hand hid: the whole product, upright, on white. Placing products into scenes for carousel cards is planned | $0.01 per image |
| Muse Spark Open (Baseten) | The prototype's seller, as a tool-calling agent: searches the shelf, matches a buyer's photo against a numbered sheet of the shop's cut-outs, shows product cards, places and looks up orders, asks the owner; answers in Kazakh, Russian or English, and code checks every price in its reply | Hackathon ID `meta-models/muse-spark-open-1026` |

Listening is the one job not done by a Meta model. Muse Voice Transcribe has no Russian or Kazakh, and Muse Spark and Muse Spark Open missed spoken prices in most test runs, so **ElevenLabs Scribe v2** transcribes the owner's narration. Everything after the transcript is Meta's models. See [findings.md](findings.md).

## Spending

Meta's "Spend Limit" only sends a notification, so spending is capped in code. In airi.chat every Meta call returns its list-price cost for airi's per-workspace AI spend limit; in the prototype, a spend ledger (`packages/meta/src/budget.ts`) refuses calls once estimated spend reaches `META_BUDGET_USD`. A model without a known price can't be called at all.

## Code

In airi.chat:

- `airi/packages/airi-runtime/src/meta-model-api.ts`, `meta-sam.ts`: the Meta Model API client (Muse Spark, Muse Image, SAM 3.1 through `@meta-sam/parser`, file upload), with timeouts and retries Temporal can rely on.
- `airi/apps/temporal-worker/src/media/product-video/`: the pipeline above.
- `airi/apps/web/src/components/products/`, `lib/products/`, `models/workspace-product.ts`: the Products section and its data.

In the prototype:

- `packages/meta`: Meta Model API and Baseten clients, SAM 3.1 segmentation, the spend ledger.
- `packages/catalog`: the first video-to-catalog pipeline.
- `packages/seller`: the seller agent (Muse Spark Open): its tools, the loop that runs them, and the checks on its replies.
- `apps/server`: Hono server with SQLite: shops, videos, products, chats, orders and questions for the owner, and a video queue that survives restarts.
- `apps/web`: the prototype's studio and the shop page with the chat (Vite, Tailwind).
- `scripts/`: the catalog CLI and the experiments behind [findings.md](findings.md).
