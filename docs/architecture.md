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

Built so far in airi.chat: the Products section, the Meta Model API client, the pipeline and the import job that runs it. Uploading from the Products page, the review, the WhatsApp drafts and sending a video to Airi on WhatsApp come next, in that order.

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
       Muse Image restores what the hand hid, level, on a plain backdrop ──► SAM 3.1 cuts it out ──► Muse Spark: same product?
                                                                                             │
                                          products with photos, for the owner to check and publish in airi.chat
```

Products are grouped the way the shop sells them. A product is what a buyer orders by one name at one price, said aloud or written on screen as a headline; every item shown for it, such as several designs, sizes or shapes, or the panels and clocks named in one sentence, is one of its options, with its own photo. The shelf shows the featured option: the item shown as the narration reaches "today" when it tells how something began, otherwise the item presented for sale, otherwise the clearest. Long sentences carry time marks inside the transcript, so Muse can tell which words went with which shot.

Owners don't always film the way they're asked, so the pipeline also takes an edited promo: cuts between scenes, a presenter talking to the camera, products shown behind them, headlines, subtitles and price stickers. An item's frame is only chosen from the shot Muse picked (a cut is a jump between frames many times bigger than the change around it, so a hand swinging a product doesn't count); Muse confirms the crop shows the item before anything is restored, and falls back to SAM on Muse's own frame when it doesn't. People are taken out of the item's mask before it's measured: a presenter's white blouse taken in with a white medal holder had hidden its slant. An item filmed at a slant is levelled to horizontal or vertical, whichever is nearer, from the tightest rectangle around its outline and once Muse agrees it looks right, before Muse Image restores it (a quarter turn between the two later needs no redrawing); an item the frame cuts off gets room around it, and Muse Image completes its ends to match.

Muse Image restores the item evenly lit on a plain colour it has little of: a flat grey, white for an item with noticeable grey, or charcoal for a light item whose own shading is grey (on grey, a white holder's shaded plate tore its slots when cut out). It removes subtitles, stickers, people and neighbouring items and keeps openings open; the backdrop showing through holes and openwork is then cut away, where a region sits on the backdrop's colour on average and not just near it, so grey lettering and dark prints stay. Along the item's outline, opacity is read from colour, so no rim of backdrop shows on a light or dark page. Muse Spark first reads the item's lettering, and words the video hid are written in: a buyer's name under a price sticker becomes a default full name in the narration's language (and the owner is told), other hidden words Muse Spark's best guess. A personalised item's few pieces of lettering are all written out, so no guess at the half of a name that showed survives; on a family tree with many names only the hidden ones are, and the rest are kept (dictating them all made Muse drop name plates). A restore the same-product check rejects (a video caption drawn onto the item counts), or a safety filter refuses, is tried once more; when both fail, the filmed photo is used, without the people.

Prices only written on screen are taken with a note to confirm, starting prices ("from 15 500") are marked so the shelf says so, a price said once for several products is flagged on each of them (told apart by the sentence it was said in), and counts like "26 000 families" aren't taken for prices. The person presenting is cut out, without the subtitles over them, and kept with the import.

On QazOner's 36-second promo, filmed as an advert rather than to the brief: 4 products as the shop sells them (шежіре from 15 500 in 6 designs, 5 to 8 across runs; the medal holder from 16 900, levelled from a 37° slant, its cut-off end completed and its hidden name written as an example; ethno panels and clocks from 15 500 in 4 items; and the dancing table from 35 000), every price right and marked as a starting price, all 12 photos restored, and the presenter kept; 6.5 minutes and $0.72. The 65-second shelf video still gives 7 products with 7 restored photos, for $0.45.

In airi.chat the pipeline is in the Temporal worker, `airi/apps/temporal-worker/src/media/product-video/`, run by one import job per video. The job saves each step as it finishes (the transcript, the draft products, each photo), so a retried job resumes instead of paying again, and the panel hears live as each product's photo lands. On the 7-product test video it found all 7 products with the right prices and restored all 7 photos, in about 3 minutes for $0.37 of Meta calls; a retry after that took 11 s and paid nothing.

## Models

| Model | Job | Notes |
| --- | --- | --- |
| Muse Spark 1.3 | Watch the silent shop video with the owner's transcript as text; list products, prices, doubts, and each product's clearest moment and search phrase | MP4 input only; about $0.045 per minute of video |
| Muse Spark 1.3 (vision) | Per item: pick the clearest of 8 frames and draw a box around it, confirm the chosen crop really shows the item, read its lettering, check the restored photo is still the same item, and confirm a levelled photo looks right. Per video: pick the frame that shows the presenter best, and check their cleaned-up photo is still the same person | Five or six image calls per item, two per video |
| SAM 3.1 | Track that box through the product's shot at 10 fps, so the best frame is chosen by measuring its mask; take people out of the item's mask; cut the restored product out of Muse Image's plain backdrop; cut out the person presenting the products | About $0.02 per item |
| Muse Image 1.0 | Restore what hands, people and captions hid: the whole item, level, evenly lit on a plain grey, white or charcoal (whichever the item has least of), its ends completed when the frame cut them off, words the video hid written in as examples, openings left open, without the subtitles and price stickers of an edited video; remove the subtitles laid over the presenter. Placing products into scenes for carousel cards is planned | $0.01 per image |
| Muse Spark Open (Baseten) | The prototype's seller, as a tool-calling agent: searches the shelf, matches a buyer's photo against a numbered sheet of the shop's cut-outs, shows product cards, places and looks up orders, asks the owner; answers in Kazakh, Russian or English, and code checks every price in its reply | Hackathon ID `meta-models/muse-spark-open-1026` |

Listening is the one job not done by a Meta model. Muse Voice Transcribe has no Russian or Kazakh, and Muse Spark and Muse Spark Open missed spoken prices in most test runs, so **ElevenLabs Scribe v2** transcribes the owner's narration. Everything after the transcript is Meta's models. See [findings.md](findings.md).

## Spending

Meta's "Spend Limit" only sends a notification, so spending is capped in code. In airi.chat every Meta call returns its list-price cost for airi's per-workspace AI spend limit; in the prototype, a spend ledger (`packages/meta/src/budget.ts`) refuses calls once estimated spend reaches `META_BUDGET_USD`. A model without a known price can't be called at all.

## Code

In airi.chat:

- `airi/packages/airi-runtime/src/meta-model-api.ts`, `meta-sam.ts`: the Meta Model API client (Muse Spark, Muse Image, SAM 3.1 through `@meta-sam/parser`, file upload), with timeouts and retries Temporal can rely on.
- `airi/apps/temporal-worker/src/media/product-video/`: the pipeline above, and `import-job.ts`, which runs it for one import.
- `airi/apps/temporal-worker/src/workflows/product-video-import.ts` and `activities/product-video-import.ts`: the Temporal workflow and its activity, on the media queue.
- `airi/apps/web/src/lib/products/imports.ts` and `app/api/workspaces/[workspaceId]/products/imports/`: starting an import from an uploaded video, and following it.
- `airi/supabase/migrations/20261028090000_workspace_ai_spend_meta_provider.sql`: lets Meta calls count against a workspace's AI spend.
- `airi/apps/web/src/components/products/`, `lib/products/`, `models/workspace-product.ts`: the Products section and its data.

Going live in airi.chat takes, in order: applying that migration to production; `META_MODEL_API_KEY` in the worker's secrets; deploying the worker, then the web app; and turning on the `products` flag for a workspace. None of these is done yet.

In the prototype:

- `packages/meta`: Meta Model API and Baseten clients, SAM 3.1 segmentation, the spend ledger.
- `packages/catalog`: the first video-to-catalog pipeline.
- `packages/seller`: the seller agent (Muse Spark Open): its tools, the loop that runs them, and the checks on its replies.
- `apps/server`: Hono server with SQLite: shops, videos, products, chats, orders and questions for the owner, and a video queue that survives restarts.
- `apps/web`: the prototype's studio and the shop page with the chat (Vite, Tailwind).
- `scripts/`: the catalog CLI and the experiments behind [findings.md](findings.md).
