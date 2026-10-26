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

Decision: ElevenLabs Scribe v2 does the listening. Meta's models take the transcript from there as text, which they read reliably, and the owner confirms prices in the studio.

### SAM 3.1 on one sharp frame beats tracking the whole video

- Whole video, concept "toy": 16 tracks for 4 real toys (background toys, fragments, the same cup twice, motion blur), $0.39.
- Per product, one frame: Muse Spark names each item with a specific phrase ("pink toy phone") and a clearest moment; the sharpest of 20 local frames around it goes to SAM as a single image. 6 of 7 items found at confidence 0.88–0.98, about $0.0025 each.
- Muse Voice Transcribe is not an option for this: its 25 languages include neither Russian nor Kazakh.

Cut-outs keep the product's real pixels; SAM's mask only decides what becomes transparent.
