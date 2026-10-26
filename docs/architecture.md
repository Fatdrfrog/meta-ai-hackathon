# Architecture

A shop films its products once. Meta's models turn the video into a catalog, and an AI seller uses that catalog to answer customers on WhatsApp.

## Who uses what

| Who | Where | What they do |
| --- | --- | --- |
| Shop owner | **Studio**, a mobile web page opened from a link | Upload the product video, confirm the items the AI is unsure about, fix prices, publish, see orders |
| Buyer | **WhatsApp**, on the shop's number | Send a photo, voice note or question; get matching products; order |
| Buyer | **Shop page**, a public web catalog | Browse every product for free; tap through to WhatsApp to ask or order |
| Judges | **Web chat** | The same seller as on WhatsApp, without needing a phone number |

The owner never makes decisions inside WhatsApp. Since October 1, 2026, Meta bills every service message after the first 1,000 per number each month, so a review dialogue in chat would cost money on every tap. The studio does the same job for free.

Owners are also starting to work in assistants like Claude. An MCP server over the same API, so an owner can manage the shop from Claude, is planned after the core works.

## Message costs

Every AI reply to a buyer is a paid message once the free 1,000 are used up, so the seller is built to spend as few as possible:

- One rich reply per buyer turn: a carousel shows up to 10 products in a single message.
- No "thinking…" or acknowledgement messages.
- Browsing happens on the free shop page; WhatsApp is for questions and orders.
- Messages per order is tracked as a cost metric.
- Buyers arriving from Click-to-WhatsApp ads are free for 72 hours.

## Separate from airi.chat

[airi.chat](https://airi.chat) is our existing, private WhatsApp product. This project is built apart from it, so judges can see exactly what is new and anyone can run the demo from this repository alone.

| | This project | airi.chat |
| --- | --- | --- |
| Code | This public repository, all written during the hackathon | Private repository; nothing imported or copied |
| Model keys | Our own hackathon Meta Model API and Baseten keys | Not used |
| WhatsApp | Our own Meta developer app and phone number | Not used |
| Data | Local storage and synthetic demo data | Not touched |

The two meet at one documented contract, the **channel**: a customer message comes in, and the seller's replies go out. Each way of reaching customers is a channel:

1. **Web chat**: a WhatsApp-like chat in the browser, for judges and local demos. No phone number needed.
2. **WhatsApp Cloud API**: through our own Meta developer app and number.
3. **airi.chat bridge** (later): a small adapter inside airi.chat forwards a shop's messages to this service and sends the replies back. This is how a shop already on airi.chat, including one using WhatsApp coexistence, keeps its number and its phone app. The adapter lives in airi.chat's private code; this repository only defines the contract it speaks.

## Pipeline

```
shop video ──► normalize (ffmpeg) ──┬─► audio ──► Scribe: timestamped transcript ──┐
                                    └─► video ─────────────────────────────────────┴─► Muse Spark: products,
                                                                                         prices, doubts, clearest
                                                                                         moment, search phrase
                                                                                               │
              sharpest local frame per product ──► SAM 3.1 (one image) ──► cut-out ◄───────────┘
                                                                              │
                                                    catalog (owner confirms doubts in the studio)
                                                                              │
customer photo / voice note / text ──► channel ──► AI seller (Muse Spark Open) ──► reply with matching products
```

## Models

| Model | Job | Notes |
| --- | --- | --- |
| Muse Spark 1.3 | Watch the shop video with the owner's transcript as text; list products, prices, doubts, and each product's clearest moment and search phrase | MP4 input only; about $0.045 per minute of video |
| SAM 3.1 | Cut each product out of its sharpest frame, found by its search phrase | $0.0025 per image |
| Muse Spark Open (Baseten) | The customer-facing seller: reads photos and voice notes, matches the catalog, takes orders | Model ID `meta-models/muse-spark-open-1026` |
| Muse Image | Studio background around the real cut-out; the product pixels are never redrawn | Planned |

Listening is the one job not done by a Meta model. Muse Voice Transcribe has no Russian or Kazakh, and Muse Spark and Muse Spark Open missed spoken prices in most test runs, so **ElevenLabs Scribe v2** transcribes the owner's narration and buyers' voice notes. Everything after the transcript is Meta's models. See [findings.md](findings.md).

## Spending

Meta's "Spend Limit" only sends a notification. Every call here goes through a spend ledger (`packages/meta/src/budget.ts`) that refuses calls once estimated spend reaches `META_BUDGET_USD`. A model without a known price can't be called at all.

## What exists so far

- `packages/meta`: Meta Model API client (Responses, Files, streaming), SAM 3.1 video segmentation via `@meta-sam/parser`, the spend ledger.
- `scripts/spike-video.ts`, `scripts/spike-sam.ts`: first experiments on a real shop video, to check the pipeline works before it's built.
