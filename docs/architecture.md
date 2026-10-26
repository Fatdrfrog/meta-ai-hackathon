# Architecture

A shop films its products once. Meta's models turn the video into a catalog, and an AI seller uses that catalog to answer customers on WhatsApp.

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
shop video ──► normalize (ffmpeg) ──► Muse Spark: products, narration, prices, SAM concepts
                                  └─► SAM 3.1: track each product, one id per item ──► best-frame cut-outs
                                                                    │
                                              catalog (owner confirms unsure items)
                                                                    │
customer photo / voice note / text ──► channel ──► AI seller (Muse Spark Open) ──► reply with matching products
```

## Models

| Model | Job | Notes |
| --- | --- | --- |
| Muse Spark 1.3 | Watch the shop video and hear the narration together; list products and spoken prices | MP4 input only |
| SAM 3.1 | Find and track every product through the video | $0.20 per 1,000 frames, minimum 50 frames per call, up to about 10 minutes per clip |
| Muse Spark Open (Baseten) | The customer-facing seller: reads photos and voice notes, matches the catalog, takes orders | Model ID `meta-models/muse-spark-open-1026` |
| Muse Image | Studio background around the real cut-out; the product pixels are never redrawn | Planned |

Muse Voice Transcribe is not used: its 25 languages include neither Russian nor Kazakh. Voice notes go to Muse Spark's own audio input instead.

## Spending

Meta's "Spend Limit" only sends a notification. Every call here goes through a spend ledger (`packages/meta/src/budget.ts`) that refuses calls once estimated spend reaches `META_BUDGET_USD`. A model without a known price can't be called at all.

## What exists so far

- `packages/meta`: Meta Model API client (Responses, Files, streaming), SAM 3.1 video segmentation via `@meta-sam/parser`, the spend ledger.
- `scripts/spike-video.ts`, `scripts/spike-sam.ts`: first experiments on a real shop video, to check the pipeline works before it's built.
