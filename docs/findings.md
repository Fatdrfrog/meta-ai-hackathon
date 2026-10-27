# Findings

Experiments on real footage, in order. Each one changed the design.

## Oct 26–27: a 65-second home video with Kazakh narration

Test clip: 7 household items filmed by hand on a phone (portrait, 30 fps, 1,949 frames), each named with a price in Kazakh.

### Muse Spark sees reliably

Every run listed the same 7 products, merged repeated sightings, ignored background objects when asked, and gave usable "clearest moment" timestamps. One video call costs about $0.045 (about 18,000 input tokens for 65 seconds).

### Muse Spark hears unreliably

The same file, with the same prompt or nearly the same, gave very different speech results:

| Run | Result |
| --- | --- |
| Inventory prompt, fresh upload | Exact Kazakh transcript, every price right |
| Inventory prompt, same file | Invented a Russian narration with no prices |
| Transcription-only prompt, same file (×2) | "NO SPEECH" |
| Transcription-only prompt, new upload (×2) | Once a Kazakh transcript with two prices different from the first run; once "NO SPEECH" |
| Audio track alone as `input_audio` (×2) | Once garbled romanized Kazakh with wrong prices; once "I can't hear any audio" |

| Speech harness, audio alone, low reasoning effort | "NO SPEECH" |

Five of nine attempts heard nothing, and none got the doll's price (5,000 tenge, "бес мың") right. Input token counts were identical whether or not the speech came through, so a response can't be trusted to have used the audio.

### A dedicated speech model hears every price

`pnpm spike:speech` transcribes the narration several times per model and checks the prices it reads against the owner's real ones (7 items; rooster and doll confirmed by the owner, the rest agreed by both dedicated models):

| Model | Runs that heard speech | Prices right per run | Time |
| --- | --- | --- | --- |
| ElevenLabs Scribe v2 | 5 of 5 | **7/7** in every scored run, both confirmed prices every time | 5–9 s |
| OpenAI gpt-4o-transcribe | 3 of 3 | 2 runs good; 1 run collapsed "бес жүз" to "5"; garbled Kazakh spelling | 4 s |
| Muse Spark Open (Baseten) | 2 of 2 | 4–5 of 7, missed both confirmed prices | 12–15 s |
| Muse Spark 1.3 | 1 of 3 | Mostly nothing heard | 8–12 s |

Scribe also returns word timestamps, so each sentence ("[38.0] Кукла Лолдың бағасы бес мың теңге.") can be matched to the moment the product is on screen.

### The whole pipeline, one run

Scribe transcribes; Muse Spark watches a muted copy of the video with the transcript as text (given the sound too, it sometimes invented its own narration); each product's sharpest frame goes to SAM 3.1. On the test clip: all 7 products cut out, all 7 prices right, every price backed by a quote that was checked word for word against the transcript. 64 seconds (prepare 13, listen 7, watch 28, cut 15), about $0.07.

### Cut-outs: Muse locates, SAM tracks, code measures

Cutting each product from its "sharpest" single frame failed on 2-3 of 7 products, for two reasons:

- **Sharpness of the whole frame picks the background.** The rooster's chosen frame had a crisp wall behind a blurred, half-hidden rooster; a clean view existed half a second later.
- **Phrase prompts are brittle.** "black phone stand" found nothing in a frame where the stand filled half the picture.

What we tried, on all 7 products:

| Method | Clean, complete cut-outs |
| --- | --- |
| Phrase on the frame sharpest overall (first version) | 4-5 of 7 |
| Muse picks a frame from a numbered grid, boxes it, SAM cuts the box | 4 of 7: fixed the stand, but the hand leaked into the rooster and the dinosaur broke in two |
| **Muse picks and boxes once; SAM tracks that one object through the product's clip; code scores every frame's mask** | **7 of 7, confidence 0.98-0.99** |

The scoring that works: keep frames whose mask is in one piece and clear of the frame's edge, then only those at least 70% of the object's largest view (otherwise a sharp close-up of the doll's face beat the whole doll), then the sharpest of the *product's own region*. A SAM "hand" mask is subtracted from the winner. Two more lessons: inside a grid, Muse answers boxes in the grid's coordinates, so it only picks the frame there and boxes on the full-size frame; and post-training was not the lever, since every failure was a choice of frame or prompt, not SAM's segmentation.

Cost and time: about $0.03 and 35-50 seconds per product, products in parallel. The whole 65-second test video takes 2-2.5 minutes and about $0.25.

Decision: ElevenLabs Scribe v2 does the listening.

## Oct 27: the AI seller on Muse Spark Open

Muse Spark Open (open weights, served by Baseten) answers buyers. First probes:

- Given no catalog at all, it answered "the doll costs 5000 tenge": an invented price. So every price in a reply is checked in code against the catalog before a buyer sees it; a reply may state any product's price, several of a product it shows or orders, and the order's total. A first version allowed multiples of every product, and the unit tests showed a made-up 4 500 ₸ "discount" passing as fifteen 300 ₸ dinosaurs; multiples are now limited to the products the reply is about.
- It recognized the doll in a buyer's photo against a numbered sheet of the shop's cut-outs, in one call.
- Structured JSON output works; with low reasoning effort replies take about a second.

A failed check gets one corrective retry with the problems spelled out; if that fails too, the buyer gets "I'll check with the owner" and the owner gets the question.

`pnpm seller:eval` runs scripted conversations against the test catalog and checks each reply in code: language, product cards, prices, questions passed to the owner, orders only after a name and phone, and length. Its first run caught replies copying catalog details in brackets and an order confirmation that still asked a question; after tightening the instructions, 8 of 8 pass, twice in a row, at 0.7-5.5 seconds per reply.

Testing the shop page chat in a browser found one more: answering a buyer's photo, the seller said "это товар 5 на фото", leaking the internal label from the product sheet. Label mentions are now one of the checks (and part of the evaluation), and the instructions forbid them. Meta's models take the transcript from there as text, which they read reliably, and the owner confirms prices in the studio.

### SAM 3.1 on one sharp frame beats tracking the whole video

- Whole video, concept "toy": 16 tracks for 4 real toys (background toys, fragments, the same cup twice, motion blur), $0.39.
- Per product, one frame: Muse Spark names each item with a specific phrase ("pink toy phone") and a clearest moment; the sharpest of 20 local frames around it goes to SAM as a single image. 6 of 7 items found at confidence 0.88–0.98, about $0.0025 each.
- Muse Voice Transcribe is not an option for this: its 25 languages include neither Russian nor Kazakh.

Cut-outs keep the product's real pixels; SAM's mask only decides what becomes transparent.
