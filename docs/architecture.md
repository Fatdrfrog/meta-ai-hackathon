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

Built so far in airi.chat: the Products section, the Meta Model API client, the pipeline, the import job that runs it, uploading from the Products page with the import followed live, the review, the WhatsApp drafts, and sending a video to Airi on WhatsApp.

On the Products page the owner chooses a video or drops it on the page. The page checks it first (a video, at most 5 minutes and 1 GB, the import's own limits), then uploads it the way the Assets page does, straight to storage through a signed link, showing the bytes sent. Once the import starts, the page follows it: the job announces each step on the workspace's realtime channel, and the page also asks again every 10 seconds while it runs, in case an event is lost. The products the job finds stand on a dashed shelf, each photo landing as it's made, until the owner checks them. The page shows imports started anywhere (another device, or WhatsApp later): running ones, ones with products left to check, and for a day those that failed or found nothing, with why.

Checking them is a card stack, one card per product, the way dating apps work. A card shows the product's photo (polished, or as filmed), its name and price, and a round clip of the owner saying the price, like a video message in a chat app. The import job cuts that clip from the video with its own sound: from the transcript's time mark just before the price's words to the next mark or sentence, 2 to 6 seconds, or 4 seconds around the item when the price was only on screen. What Airi isn't sure of is in red, with why. Our checks of the price against the narration, and the model's doubts that name a price, are about the price, and setting it settles them. Swipe right (or →) adds the product to the shelf, left (or ←) skips it; undo brings the last one back, and "Accept all" adds the rest. A tap fixes the name or price in place, or chooses which of a product's items the shelf shows. Decisions show at once and are saved behind, in the owner's order; one the server refuses comes back, and the card says so. The review has its own address (`?review=<import>`), so the link Airi will send on WhatsApp can open it, and Back closes it.

The review's last screen offers two drafts made from the products it added, written for buyers in the language the owner spoke (Kazakh, Russian or English; the owner can change any word before anything is sent). The owner finishes both in parts of airi that already exist, so nothing reaches buyers without their say:

- **Carousel template:** up to 10 products, each on a card with its cut-out centred on a white square JPEG (Meta crops every card to the first one's shape), its name and price, and an order button, under a short message. The pictures are stored in airi's media as template header samples, the way the template editor's own uploads are. The page then leaves the carousel as the template editor's unsaved draft and opens Templates in create mode, where the editor restores it, so the owner checks it and sends it to Meta from there.
- **Order form:** a one-screen WhatsApp Flow with up to 20 products to tick (their prices beside them), the buyer's name, a delivery address and a comment; WhatsApp already gives the buyer's number. It is built with the Flow JSON generator and validator airi's scenario builder uses, created empty on the workspace's WhatsApp Business Account and then given its JSON, as airi's Flow provisioning does, and left as a draft for the owner to check and publish in WhatsApp Flows. A draft whose JSON Meta refuses is deleted rather than left broken.

Owners can also send the video to Airi on WhatsApp, at airi's own number (`PRODUCTS_WHATSAPP_NUMBER`, +7 708 260 9346), from the phone they filmed it on. First the phone is linked to the workspace: "Send from WhatsApp" on the Products page shows a one-time code as a QR to scan and a link to tap, which opens WhatsApp to Airi with the code written in, the way airi's website carts hand off to WhatsApp; sending it links that phone. A number the workspace already has connected to airi counts as linked without a code. A video from a linked phone within 30 minutes of linking, or of its last video, becomes an import at once; a later one gets one question with two buttons, in case it wasn't meant for the shelf. Everything else sent to that number gets the number's usual handling. The handler sits in airi's webhook runtime right after the message is saved, so the conversation still shows it, but Airi's assistant doesn't answer it. The import job fetches the video from WhatsApp as its first step, keeps a copy in the owner's media for retries, and runs as for an upload. When it ends, Airi writes once: how many products it found and the link to check them, or why the video couldn't be read. There is no "got it" message, since every message after the free 1,000 a month is paid; the page shows the import's progress.

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

In airi.chat the pipeline is in the Temporal worker, `airi/apps/temporal-worker/src/media/product-video/`, run by one import job per video. The job saves each step as it finishes (the transcript, the draft products, each photo, each product's review clip), so a retried job resumes instead of paying again, and the panel hears live as each product's photo lands. On the 7-product test video it found all 7 products with the right prices and restored all 7 photos, in about 3 minutes for $0.37 of Meta calls; a retry after that took 11 s and paid nothing.

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
- `airi/apps/web/src/lib/products/imports.ts` and `app/api/workspaces/[workspaceId]/products/imports/`: starting an import from an uploaded video, listing the imports the Products page shows, and following one.
- `airi/apps/web/src/components/products/products-client.ts`, `use-product-video-upload.ts`, `use-product-imports.ts`, `product-video-intake.tsx`: checking and uploading a video, and following its import live.
- `airi/apps/web/src/components/products/product-review.tsx`, `use-product-review.ts`, `lib/products/review.ts`, and the routes `app/api/workspaces/[workspaceId]/products/[productId]/` and `products/imports/[importId]/review/`: the review, fixing a product, and adding products to the shelf or skipping them.
- `airi/apps/web/src/lib/products/whatsapp-drafts.ts`, `components/products/product-whatsapp-drafts.tsx`, `carousel-template-draft.ts`, and the routes `products/imports/[importId]/carousel/` and `order-form/`: the WhatsApp drafts. `lib/whatsapp/templates/header-media-storage.ts` stores template header samples for them and for the template editor's own uploads.
- `airi/apps/web/src/lib/products/whatsapp-intake.ts`, `whatsapp-number.ts`, `models/product-whatsapp-link.ts`, `components/products/product-whatsapp-link.tsx` and the route `products/whatsapp-link/`: videos sent to Airi on WhatsApp, and linking a phone. The worker reaches them through `apps/temporal-worker/src/products/whatsapp-intake.ts`, wired into airi's webhook runtime (`packages/airi-runtime/src/whatsapp-webhook-runtime.ts`).
- `airi/supabase/migrations/20261028090000_workspace_ai_spend_meta_provider.sql`: lets Meta calls count against a workspace's AI spend.
- `airi/apps/web/src/components/products/`, `lib/products/`, `models/workspace-product.ts`: the Products section and its data.

Going live in airi.chat takes, in order: applying that migration to production; `META_MODEL_API_KEY` in the worker's secrets; `PRODUCTS_WHATSAPP_NUMBER` in the worker's and the web app's environment, for videos sent on WhatsApp; deploying the worker, then the web app; and turning on the `products` flag for a workspace. The migration is applied; the rest isn't done yet.

In the prototype:

- `packages/meta`: Meta Model API and Baseten clients, SAM 3.1 segmentation, the spend ledger.
- `packages/catalog`: the first video-to-catalog pipeline.
- `packages/seller`: the seller agent (Muse Spark Open): its tools, the loop that runs them, and the checks on its replies.
- `apps/server`: Hono server with SQLite: shops, videos, products, chats, orders and questions for the owner, and a video queue that survives restarts.
- `apps/web`: the prototype's studio and the shop page with the chat (Vite, Tailwind).
- `scripts/`: the catalog CLI and the experiments behind [findings.md](findings.md).
