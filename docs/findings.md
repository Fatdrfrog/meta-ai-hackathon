# Findings

Experiments, in order, on real footage unless a section says otherwise. Each one changed the design.

## Oct 26–27: a 65-second home video with Kazakh narration

Test clip: 7 household items filmed by hand on a phone (portrait, 30 fps, 1,949 frames), each named with a price in Kazakh.

### Muse Spark sees reliably

Every run listed the same 7 products, merged repeated sightings, ignored background objects when asked, and gave usable "clearest moment" timestamps. One video call costs about $0.045 (about 18,000 input tokens for 65 seconds).

### Muse Spark hears unreliably

The same file, with the same prompt or nearly the same, gave very different speech results:

| Run | Result |
| --- | --- |
| Inventory prompt, fresh upload | A Kazakh transcript with a price for every product; checked later against the owner's real prices, 4 of 7 were right (the doll at 1 000, not 5 000; the dinosaur at 1 000, not 300; the toy money as one dollar, not 300 tenge) |
| Inventory prompt, same file | Invented a Russian narration with no prices |
| Transcription-only prompt, same file (×2) | "NO SPEECH" |
| Transcription-only prompt, new upload (×2) | Once a Kazakh transcript with two prices different from the first run; once "NO SPEECH" |
| Audio track alone as `input_audio` (×2) | Once garbled romanized Kazakh with wrong prices; once "I can't hear any audio" |
| Speech harness, audio alone, low reasoning effort | "NO SPEECH" |

Five of nine attempts heard nothing, and none got the doll's price (5,000 tenge, "бес мың") right. Input token counts were identical whether or not the speech came through, so a response can't be trusted to have used the audio.

### First SAM try: one sharp frame beats tracking the whole video

- Whole video, concept "toy": 16 tracks for 4 real toys (background toys, fragments, the same cup twice, motion blur), $0.39.
- Per product, one frame: Muse Spark names each item with a specific phrase ("pink toy phone") and a clearest moment; the sharpest of 20 local frames around it goes to SAM as a single image. 6 of 7 items found at confidence 0.88–0.98, about $0.0025 each.
- Muse Voice Transcribe is not an option for this: its 25 languages include neither Russian nor Kazakh.

Cut-outs keep the product's real pixels; SAM's mask only decides what becomes transparent.

### A dedicated speech model hears every price

`pnpm spike:speech` transcribes the narration several times per model and checks the prices it reads against the owner's real ones (7 items; rooster and doll confirmed by the owner, the rest agreed by both dedicated models):

| Model | Runs that heard speech | Prices right per run | Time |
| --- | --- | --- | --- |
| ElevenLabs Scribe v2 | 5 of 5 | **7/7** in every scored run, both confirmed prices every time | 5–9 s |
| OpenAI gpt-4o-transcribe | 3 of 3 | 2 runs good; 1 run collapsed "бес жүз" to "5"; garbled Kazakh spelling | 4 s |
| Muse Spark Open (Baseten) | 2 of 2 | 4–5 of 7, missed both confirmed prices | 12–15 s |
| Muse Spark 1.3 | 1 of 3 | Mostly nothing heard | 8–12 s |
| Muse Voice Transcribe 1.0, on the English dub of the same video (it takes neither Kazakh nor Russian) | 1 of 1 | 6/7: the rooster's "four ninety-nine" came back as a bare "499"; one run, Nov 4, $0.003 | 16 s |

Scribe also returns word timestamps, so each sentence ("[38.0] Кукла Лолдың бағасы бес мың теңге.") can be matched to the moment the product is on screen.

Meta's own docs point the same way. Its model page says "Audio understanding in Muse Spark 1.3 is not fully supported" and warns that answers to requests with audio may be worse ([dev.meta.ai/docs/models](https://dev.meta.ai/docs/models), read Nov 4), and Muse Voice Transcribe, Meta's speech model, lists 25 languages without Russian or Kazakh ([dev.meta.ai/docs/speech-to-text](https://dev.meta.ai/docs/speech-to-text)). So on Nov 4 we tried it on the one recording of this video it can take: the synthetic English dub (below), sent once as a 24 kHz mono WAV, with no language set. It heard every price line and wrote 6 of the 7 prices right, in 16 s for 65 s of audio, for $0.003 ($0.18 an hour, billed by the second). It wrote the rooster's "four ninety-nine" as "499", losing the decimal point and the currency; it mixed shapes within the clip ("$12.50" and "$15" in digits, four prices in words); it doubled one word and added a stray "dollars."; and it gave times per phrase, not per word. Scribe v2 got all 7 on the same dub.

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

Decision: ElevenLabs Scribe v2 does the listening. Meta's models take the transcript from there as text, which they read reliably, and the owner confirms prices in the studio.

## Oct 27: the AI seller on Muse Spark Open

Muse Spark Open (open weights, served by Baseten) answers buyers. First probes:

- Given no catalog at all, it answered "the doll costs 5000 tenge": an invented price. So every price in a reply is checked in code against the catalog before a buyer sees it; a reply may state any product's price, several of a product it shows or orders, and the order's total. A first version allowed multiples of every product, and the unit tests showed a made-up 4 500 ₸ "discount" passing as fifteen 300 ₸ dinosaurs; multiples are now limited to the products the reply is about.
- It recognized the doll in a buyer's photo against a numbered sheet of the shop's cut-outs, in one call.
- Structured JSON output works; with low reasoning effort replies take about a second.

A failed check gets one corrective retry with the problems spelled out; if that fails too, the buyer gets "I'll check with the owner" and the owner gets the question.

`pnpm seller:eval` runs scripted conversations against the test catalog and checks each reply in code: language, product cards, prices, questions passed to the owner, orders only after a name and phone, and length. Its first run caught replies copying catalog details in brackets and an order confirmation that still asked a question; after tightening the instructions, 8 of 8 pass, twice in a row, at 0.7-5.5 seconds per reply.

Testing the shop page chat in a browser found one more: answering a buyer's photo, the seller said "это товар 5 на фото", leaking the internal label from the product sheet. Label mentions are now one of the checks (and part of the evaluation), and the instructions forbid them.

## Oct 27: the seller becomes an agent

The first seller was one call per buyer message: the whole catalog in the prompt, one JSON answer out. It couldn't look anything up, and a shop with hundreds of products won't fit in a prompt. Muse Spark Open on Baseten handles OpenAI-style tool calling across several rounds, so the seller is now an agent with six tools: `search_products`, `match_photo` (the numbered-sheet vision call), `show_products` (cards), `place_order`, `order_status` and `ask_owner`. It gets up to six rounds per buyer message. Its actions are checked inside the tools (real product refs, quantity 1-99, a phone the shop can call), and its final reply still goes through the price and label checks. Every step is kept in a trace.

The first live evaluation, 5 of 9, found things the unit tests couldn't:

- It sent the phone as a JSON number (`87011234567`) though the tool's schema says string, so the order was refused and it asked the buyer for the phone again. The tools now take numbers and strings either way.
- It wrote prices without the tenge sign ("is 500", "на сумму 300"). The price check only read amounts with ₸, so a bare made-up "для вас 4000" would have passed too. Tools now give prices as "5 000 ₸", and the check reads bare numbers from 100 up as well, leaving out phone numbers and digits inside product names.
- It said "вот что нашлось:" and never showed the cards. A reply ending in a colon is now sent back for a correction.
- Word search misses translations: "қуыршақ" doesn't match "Кукла Лол", and it took four searches to get there. A search with no match now returns the whole shelf for shops of up to 30 products, and the Kazakh question takes one search.
- Asked what they had ordered, it once answered from its own earlier message instead of calling `order_status`. That was right this time, but it only sees the last 12 messages, so it is now told to always check.

After the fixes, 9 of 9 pass, twice in a row. That includes a new order-status case where the buyer orders in one message and asks what they ordered in the next. Replies take 1.4-6 seconds, or about 11 seconds with a buyer photo because of the separate vision call. A full evaluation run costs about $0.03. With an ambiguous request ("телефон-игрушка" matches a toy phone and a phone stand), it now shows both and asks which one.

## Nov 1–2: narrations in other languages

We wanted the import in airi.chat to work for shop owners anywhere, in any language ElevenLabs Scribe transcribes; ElevenLabs lists 90+ languages for Scribe v2 in its [speech-to-text docs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text). Until then, the import read a price with no currency as tenge, rounded every price to a whole number and flagged any other currency. Before changing it, we looked at what Scribe really writes.

### What Scribe writes in 10 languages

Test clips, synthetic: one short voice-over per language, made with ElevenLabs' eleven_v3 text-to-speech in one voice, in English, Spanish, Turkish, Japanese, Chinese, Hindi, Arabic, Thai, Vietnamese and Greek. Each says three prices, two of them equal. We also dubbed the 65-second shelf video into English and Japanese, with prices in dollars and yen, line by line at the times of the owner's Kazakh lines. Each recording went through the import's own audio step, then Scribe v2 with no language set, as the import calls it.

- **It found the language every time.** Scribe named the right language for all 12 recordings, with a probability from 0.94 (Turkish) to 1.0 (Japanese), and for the 3 real Kazakh recordings below, at 0.91 to 0.93. Every word came with a start and an end time.
- **A price takes a different shape in each language.** Digits in English ("$12.50"), Turkish ("149,90", with a decimal comma), Hindi ("₹1,49,999", in Indian grouping) and Arabic; words in Spanish, Vietnamese, Greek and Thai ("doce euros con cincuenta", "δώδεκα κόμμα πενήντα ευρώ"); kanji and Chinese numerals in Japanese and Chinese ("千五百円", "十九点九元"). The shape changed within a language too: the English dub's prices came back as words ("four ninety-nine"). Scribe never wrote a digit other than 0–9, though the Arabic voice-over's text had Arabic-Indic digits, and only in the English clip and in Hindi did a spoken currency become its sign ("$", "₹").
- **Sentence marks differ by language.** "." in six languages, "。" in Japanese and Chinese, "।" in Hindi, "،" and "؟" in Arabic, ";" for the Greek question mark, and no marks at all in Thai. Some sentences were joined: all three Chinese ones with "，", two Hindi ones with no "।" before "और", and two Arabic ones with "،". In the Japanese dub, 2 of the 14 "。" came glued to the start of the next word ("。LOL").
- **Japanese, Chinese and Thai come one character or syllable per word**, with no spaces, except two in Thai, exactly at its clause breaks.
- **Two numbers changed on the way**, and we can't tell whether the voice or Scribe changed them: Turkish "1.250 lira" came back as "bir 250 lira", and Arabic "١٢٫٥٠" (12.50) as "1850". Arabic also put an invisible right-to-left control character at the start of that number.

### What that changed

The transcript code before, which ended sentences only at ". ! ?", made one line each of the Japanese, Chinese, Hindi and Thai clips and of the Japanese dub, and the time marks it put inside long sentences fell inside words and prices ("千五[15.1] 百円", "ห้าสิบ[1.6] บาท"). Now sentences end at the marks of every script, including one glued to the next word; the checks read Chinese, Japanese and Thai words across the time marks inside them, and compare quotes without invisible control characters; and a narration in an unspaced script with no marks at all splits at pauses, which gives the Thai clip its 3 clauses. Lines before and after: Japanese 1 → 3, Hindi 1 → 2, Arabic 2 → 3, Thai 1 → 3, Greek 3 → 4, and the Japanese dub 1 → 14. English, Spanish, Turkish, Vietnamese and the English dub keep their lines, and Chinese stays one line, since Scribe joined its sentences with commas.

We ran the price checks on every recording with hand-built products, quoting either just the price words or the whole sentence, as Muse might. On the new lines, the only false doubts are 2 each in Chinese, Hindi and Arabic, where two equal prices share a sentence and the quote is just the price words ("Another product's price comes from the same words."); whole-sentence quotes give none. The old lines had drawn that doubt for the equal prices in Japanese, Thai and the Japanese dub, which the new lines no longer do. The Turkish and Arabic prices that changed on the way get a true "The price differs from the number in the narration."

The real Kazakh recordings shaped one rule. Re-transcribed on Nov 2, the shelf video, QazOner's promo and the promo as WhatsApp delivered it came back with only "." and ",", every price in words ("бес мың теңге") and a space after every word, and the new code gives them byte-identical lines to the old: 16, 9 and 9. With their marks stripped (a simulation on the real timings), a first version that split any unpunctuated narration at pauses gave the shelf 21 lines and cut four amounts off from the words before them, since the owner pauses before saying the amount ("бағасы | бес мың теңге", 1.5 s). So only a narration in an unspaced script splits at pauses; a spaced one without marks stays one line, as before. Scribe's words weren't fixed either: against Oct 28's transcripts of the same audio, it heard a few words differently (Подставканың became Подставка) and added a few sentence breaks, while every price and the style of punctuation held.

### Muse Spark on the new code

The product list only, from Muse Spark 1.3 and the checks; no photos:

| Video | Runs | Result |
| --- | --- | --- |
| The 65-second shelf video, with the owner's Kazakh narration | 3: two on Oct 28's transcript, one on Nov 2's | 7 of 7 exact prices, all KZT, in every run; no code doubts, and the only model doubt was about the rooster's spoken name, as before |
| QazOner's promo, whose Kazakh narration never says теңге | 2: one on Oct 28's transcript, one on Nov 2's | 4 products with their KZT starting prices (15 500, 16 900, 15 500 and 35 000) and no currency doubt |
| The shelf video dubbed into English (synthetic voice) | 1 | All 7 prices as said, in USD, with 12.50 and 4.99 keeping their cents; the rooster's price, said with no currency ("It's four ninety-nine."), came out USD too |
| The shelf video dubbed into Japanese (synthetic voice) | 2 | All 7 prices as said, in JPY; the two products at 千五百円 drew no false same-words doubt |

Each run cost $0.02–0.05 of Muse Spark. On the promo, the output doesn't show whether Muse took KZT from the т on the price stickers. In the runs on Nov 2's Kazakh transcripts, Muse gave a time mark inside a long sentence, not the line's start, for 4 of 11 prices. The checks now place such a price in that mark's sentence; before, two equal prices cited that way could both be flagged, or a clip could come from the wrong sentence.

### Not tested, and known limits

- One synthetic voice per language, with short pauses between sentences: real owners may punctuate, pause and say numbers differently. Lao, Urdu and Armenian weren't tried, only Kazakh, English and Japanese went through Muse Spark on the new code, and no import with photos ran in English or Japanese. ElevenLabs' own word error rates for Scribe v2 run from 5% or less (English, Russian, Spanish and Japanese among them) to 25–50% (Amharic, Lao and Urdu among them).
- Two equal prices in one sentence, as Scribe wrote Chinese, Hindi and Arabic here, can still draw a false same-words doubt when Muse quotes only the price words, and the second product's clip can play the first one's words. The same holds in a narration Scribe leaves without marks in a spaced script, which stays one line.
- A multiplier word after digits ("2,5 тысячи", "3万円") can still draw a false "differs" doubt.
- A currency word or sign several countries share is read as its default currency unless the video points to another: $ or dollar is USD, £ or pound GBP, рубль RUB, lira TRY, 元 or 块 CNY, and a bare т after a number KZT. So "dollars" is stored as USD unless the video points to another dollar (the English dub's 7 prices came out USD with no doubt); the owner sets the code on the card.
- Buyer drafts and the example names written into hidden lettering are in Kazakh, Russian or English, and in English for any other narration.

## Nov 2–3: the video ad, tested on two real videos

Before the studio went live on Nov 3, we made ads from two real videos through the real ad pipeline: the worker's ad code, run on a local machine with the hackathon's Meta and ElevenLabs keys, with a harness standing in for airi's database, storage, AI spend ledger and Temporal. The test had a $1 budget with a hard stop at $0.90, and spent $0.52, every call logged. The commits named below are airi.chat's, from its pull request 508; this repository carries them in `ab0fc64`, `20df8c4` and `715adf9`.

- **The toy shelf:** the doll and the mug from the 65-second home video above, with the owner's own Kazakh narration.
- **QazOner's promo**, shown with QazOner's permission: the family-tree panel and the dancing table, with the presenter, cut out of the video by SAM 3.1, closing the ad.

### The two ads

| | Toy shelf | QazOner's promo |
| --- | --- | --- |
| Final ad | 13.9 s, 1.66 MB | 12.9 s, 2.84 MB |
| Format | 1080×1920 H.264 High@4.0, 30 fps, AAC 48 kHz stereo, faststart | The same |
| Loudness | −16.1 LUFS, true peak −4.5 dBTP | −16.0 LUFS, true peak −4.5 dBTP |
| Full makes | 3: $0.0769–0.0795, 68–79 s | 3: the first, which tried one scene twice, $0.0912 and 105 s; then $0.0732, and $0.0701 in 64 s |
| Every run of the ad | 6, for $0.2452, two of them render-only at $0 | 4, for $0.2345, one render-only at $0 |

In the final makes, the money went roughly on the words ($0.011–0.013), two Muse Image scenes ($0.020), two same-product checks (about $0.016), two SAM boxes ($0.005) and the Voice Isolator ($0.018–0.024). A full make's time went on the words (10–20 s), the pictures (25–33 s, or 56 s with a second try), framing (4–7 s) and the video (16–32 s). A render-only run, as after the owner edits the words, took 13–19 s and cost nothing.

Muse Spark wrote the words in Kazakh, the language of both narrations, and code drew the prices from the shelf: 5 000 ₸ and 500 ₸ on the toy shelf, 15 500 ₸ and 35 000 ₸ with "бастап" ("from") on the promo. In both final files, every drawn text has every character in both bundled fonts, every word layer sits inside the Reels safe band, and the format is one WhatsApp takes, under its 16 MB.

### Muse Spark's same-product check

- In the final runs, all four scenes passed on the first try: the doll on a playroom shelf, the mug on a stone counter, the panel and the table. So every final scene is Muse Image's picture. The mug's printed "web umn" stayed intact, and the names engraved on the panel matched its restored cut-out.
- In QazOner's first run, Muse Image left out the panel's outer frame, and Muse Spark said so: the scene "omits the outer square frame with top and bottom banners". The retry, with that difference added to the prompt, passed.
- Every run of the toy shelf passed on the first try.

### Where Muse Image puts a product

- The first prompt asked for the product "centred at 45%, half of its width". Tall and wide products then filled the picture up into the words and past the 9:16 sides, and the doll's top stood at 12% of the picture's height. Asked instead for the whole product upright in the lower half, at about half the picture's height (`f152cf8ef`, `05b618307`), the final scenes put the top of the doll at 35%, the mug at 21% and the panel at 29%; SAM's box put the table's top at 29% too, but the deer standing on it reached 11% (below).
- It still varies from run to run. With the same final prompt and cut-out, a lab run put the top of the dancing table's deer figure at 30% of the picture, and the final make at 11%, where the label and the price tag cover the deer's body. SAM 3.1 had boxed only the table, not the deer, so the band above looked free. `61bfb2ee5` now grows a box much flatter than the cut-out's own shape to the whole product, but a $0 what-if on the stored answers shows the label would still cover the deer in this picture. The paper label is opaque, so the words stay legible.

### The voice

- Each ad's voice is the owner's own words, cut from the video's original sound: the doll's and the mug's price clips, and the presenter's lines about the panel and the table.
- The ElevenLabs Voice Isolator ran in every make, booked in the ad's AI action ($0.024 on the toy shelf, $0.018 on the promo), and its answers lined up with what was sent (no lag, correlation 0.92–0.99). It only turned the background down. In its answers the background was about 0–5 dB lower, and QazOner's music bed, at about −37 to −38 dB under words at about −15 dB, stayed audible, its tones still in the spectrogram. In a lab run, ffmpeg's denoiser after the isolator took off only 1–1.5 dB more; the ad runs the denoiser only when the isolator's answer can't be used.
- The isolator refuses a recording under 4.6 s (HTTP 400, nothing billed), so an ad with one short price clip had fallen back to the denoiser without a word. Since `d7ffdf0ed` the clips are sent padded to 5 s, and since `710ff43ae` a skipped isolator is logged with why.
- Most of the polish we could measure came after the isolator: the code's tightened pauses (the doll's clip went from 3.70 to 2.35 s, the mug's from 5.90 to 3.64 s and its longest pause from 0.94 s to none), ffmpeg's lower rumble cut (two 100 Hz high-pass stages left the room rumble 5.7 dB lower than one stage at 80 Hz, and the words 0.6 dB lower, `d7ffdf0ed`), the code's fades and ffmpeg's loudness. After all of it, the words stood 33.0 dB over the background on the doll's clip (19.8 dB before) and 38.4 dB on the mug's (28.7 dB). QazOner's lines run on with no pauses to tighten: 20.4 dB on the panel's (21.3 before) and 20.1 dB on the table's (17.0).
- So the ad's brief says the background noise is "turned down", not taken out (`612e91fc4`). A stronger denoiser, such as an RNNoise model, wasn't tried.

### Fixes from the test

| Commit | What the test found | The fix |
| --- | --- | --- |
| `f152cf8ef` | Products stood up into the words and past the 9:16 sides, and Muse Spark dropped every ".", "?" and hyphen from the words | The scene prompt asks for a medium-sized product in the lower two thirds; the words' rules ask for normal punctuation, the shop's name as given, and "WhatsApp-қа" |
| `d7ffdf0ed` | The Voice Isolator refused a recording under 4.6 s, and room rumble stayed | Recordings are padded to 5 s, and the rumble cut is two 100 Hz high-pass stages |
| `369c2b126` | The Status picture showed small products on an empty wall | Products on the price card stand up to 600 px tall, from 480 |
| `94a414d98` | With the voice tightened, the first product's price was whole on screen for about 0.15 s | The first scene lasts at least 4.6 s, within the 20 s cap: its price now shows for about 1.7 s |
| `05b618307` | A figure standing on a product reached up into the words, and a caption borrowed the next product's line | The prompt asks for the whole product, anything standing on it included, in the lower half at about half the picture's height (in a lab run, the deer's top moved from 17% to 30% of the picture, the panel's from 19% to 25%); the words' prompt says the lines around a product may be about other products |
| `56a53cd08` | Muse Spark wrote «җуыршақ» with the Tatar letter җ, which the fonts draw, so the checks passed it | A Kazakh script with a Cyrillic letter Kazakh doesn't use goes to the repair call |
| `86c063dc1` | A two-line caption split «Көк көйлек» across its lines | A two-line caption breaks where its lines come out even |

The review after the test added more: `9a356ca3f` gives the words only the narration about each product, where `05b618307` had only asked the prompt to set other products' lines aside; `3927a5e27` runs the Kazakh check whatever name Muse Spark gives the language; `61bfb2ee5` grows a partial SAM box to the whole product; and `cabe854c5` drops a price tag in only as far as keeps its ink inside the safe band (its drop had started 6–7 px above it).

### Rendered again with the final code

After the review, both ads were rendered again from the test's saved scenes, words and voices, in render-only mode, with the code of the pull request's commit `409e0311b`; its later commits changed no worker file, and in the shared package only how the page's ledger sets a price apart. No model was called: no key was read, the network was blocked, and every paid call would have thrown. Both passed, for $0:

- The 6 frames sampled from each, its Status, 4:5 and poster pictures, and its decoded sound, sample for sample, were identical to the test's.
- The one change was the price tag's drop-in (`cabe854c5`): 20 px on the toy shelf and 19 px on the promo instead of 26, during its 0.3 s fade-in, so its ink no longer starts above the safe band. Both ffmpeg graphs, rebuilt, reproduced both MP4s bit for bit, and the other frames that differ are encoder carry-over at a PSNR-Y of 42 dB or more.
- On each, 11 of 11 drawn texts had every character in both fonts, 9 of 9 inked layers sat inside the safe band, at rest and as they move in, and the true peak, −4.5 dBTP, was under the −1.5 dBTP target.
- The label still covers the deer on the promo's table, as in the test: the box fix runs only in a paid make.

### Not tested, and known limits

- Nobody watched or listened on a phone: the voices were judged by measurements and spectrograms.
- Everything was rendered on Windows with ffmpeg 8.0.1, not on the worker image's ffmpeg 5.1, though every filter the ad uses exists in 5.1.
- The harness stood in for the database, storage, the AI spend ledger and Temporal.
- Both ads had 2 products; an ad of 1 or 3 wasn't made.
- The Kazakh words haven't been checked by a native speaker.
- The 4:5 ad picture was compared with the test's byte for byte, not checked against its margins.
- These were local runs. The ads made in production since the studio went live are under [Production, read on Nov 4](#production-read-on-nov-4).

## Nov 3: studio v2's paid gate

Studio v2 (airi.chat's pull request 511, live on Nov 3 and not yet ported to this repository) added new words, new pictures and new voices to the video ad. Before it went live, we ran each new paid step through the real ad code on a local worker with the hackathon's Meta and ElevenLabs keys, on the two test ads above, with the same harness standing in for airi's database, storage, AI spend ledger and Temporal. Every paid call was booked in the ad's one AI action. After each run, Scribe transcribed the ad's sound, and code checked that every spoken price matched the shelf. The whole gate cost $0.446: $0.253 of Meta calls and $0.193 of ElevenLabs.

| Run | What it did | Cost | Time |
| --- | --- | --- | --- |
| Toy shelf, a full make | v2's words (3 openings and 3 endings to pick from), two Muse Image scenes, two checks, two SAM boxes, and the owner's own recording through the Voice Isolator | $0.078 | 73 s: words 22 s, pictures 30 s, framing 6 s, video 15 s |
| Toy shelf, another opening and ending | a render, no model called | $0 | 11 s |
| Toy shelf, "Your voice, new words" | 35.5 s of the owner's narration, cleaned by the Voice Isolator ($0.132), became an ElevenLabs Instant Voice Clone, which has no price of its own; text-to-speech then read a new Kazakh script in it ($0.007) | $0.139 | 32 s |
| Toy shelf, after **Remove my voice** | the clone was deleted at ElevenLabs 2 minutes after it was made, and the next render used the owner's own recording | $0 | 13 s |
| QazOner, a full make with an Airi stock voice | the words, two scenes, two checks, two boxes, and text-to-speech in a stock voice ($0.009); the words call ran in two attempts of the run, and each kept its whole $0.04 reservation, as a call that may have been billed does | $0.131 | not logged |
| QazOner, new words | Muse Spark wrote a new Kazakh script, read in the same stock voice | $0.022 | 39 s |
| QazOner, **New picture**, twice | Muse Image made a new scene in one of the tested places, Muse Spark checked it was the same product, and SAM 3.1 framed it | $0.021 and $0.022 | 58 s and 47 s |
| QazOner, a described place | "a felt rug in a yurt": Muse Spark read the place first, then came a scene, its check and its box | $0.022 | 57 s |
| QazOner, a refused place | a place with people in it: Muse Spark refused it, so no picture was made or paid for | $0.002 | 22 s |

- **Every spoken price was right.** In all 9 checked renders, Scribe found the language to be Kazakh, and each of the ad's 2 spoken prices matched the shelf, in the owner's own words, the clone's and the stock voice's. Code writes a synthesised voice's prices out as words from the shelf; a model never does.
- **The words stayed in the safe band.** In all 9, every inked layer sat inside the Reels safe band.

## Nov 3–4: studio v3's motions and pictures, rendered

Studio v3 (built in airi.chat's branch `claude/products-studio-v3`, **not live yet**) adds Reel motions and pictures that are code over what an ad already made. We rendered each motion from the two test ads' saved scenes, words and voices, render-only, with v3's worker code on a local worker. No model was called: 0 paid calls in every run. Each render also draws the ad's whole set of pictures for the Post, Story and carousel tiles: 26 for the toy shelf, which has 3 products here, and 18 for QazOner's 2.

| Motion | Shipped | Toy shelf: whole run, its pictures, the video | QazOner: whole run, its pictures, the video |
| --- | --- | --- | --- |
| Shelf ad (v2's motion) | yes | 17.5 s, 4.0 s, 16.6 s long, 2.0 MB | 15.1 s, 3.6 s, 13.0 s long, 2.9 MB |
| Filmed → Sold: each shot opens on the product as the owner filmed it, then wipes to the made scene | yes | 23.3 s, 4.2 s, 19.0 s long, 2.6 MB | 18.4 s, 4.2 s, 14.3 s long, 3.2 MB |
| Float | yes | 21.5 s, 4.9 s, 16.6 s long, 1.2 MB | 16.6 s, 4.4 s, 13.0 s long, 1.3 MB |
| Pop | yes | 29.0 s, 4.6 s, 16.6 s long, 1.6 MB | 22.4 s, 3.5 s, 13.0 s long, 2.0 MB |

The Filmed → Sold, Float and Pop runs are from Nov 3, about 20:00 UTC; the Shelf ad runs were repeated on Nov 4 at about 03:00 UTC, after the last changes to the pictures. "Shipped" is the motion's tile in `lib/products/templates.ts` at `cf1913aba`, the branch's latest commit on Nov 4 (all four since `9e5505511`; at `282e469d1` only Shelf ad and Filmed → Sold); a tile that isn't shipped isn't shown. Every video is 1080×1920 H.264 at CRF 21, under WhatsApp's 16 MB.

## Nov 3–4: Meta actions before going live

- **One `validate_only` check.** On Nov 3 at 19:49 UTC, before any v3 deploy, we sent one Marketing API ad-set create with `execution_options=["validate_only"]` to our own ad account, shaped as v3 makes it: Kazakhstan, Facebook placements, Meta's Advantage audience, promoted for our Facebook Page. Meta answered `{"success": true}`, and nothing was created. It was the only Marketing API write before the deploy.
- **Not measured yet:** the time from a Reel's container to its published post, the Graph steps of a Click-to-WhatsApp ad created paused on Facebook placements, and Meta's verdict on a carousel made since pull request 509. Studio v3 isn't live; this section gets them after the deploy.

## Production, read on Nov 4

Read-only aggregates of airi.chat's production database and AI spend ledger, on Nov 4 between 02:53 and 03:00 UTC: counts, states, times and costs only, with no names, phone numbers or ids. The `products` flag has been on in one workspace since Oct 29, our own Airi.chat, so every figure below is ours: no customer shop has used Products yet.

| What | In production |
| --- | --- |
| Shelf videos imported | 2, both sent to Airi on WhatsApp, both narrated in Russian. **Oct 30:** stopped after 2 of 5 photos on the $0.50 cap on one AI action, the failure that made each photo its own action. **Nov 2:** 5 of 5 products, 5 of 5 photos restored by Muse Image and none fell back to the filmed photo, 192.5 s from arrival to ready, $0.276 of Meta calls ($0.278 with Scribe); the owner put 4 on the shelf and skipped 1 |
| A restored photo | $0.045–0.053 of Meta calls, over the 7 photos made |
| Video ads | 2, on Nov 3, 3 products each, 1080×1920, 16 s and 17 s long, in Russian. **Ad 1:** $0.076 in 95 s (words 23 s, pictures 33 s, framing 8 s, video 29 s), slower than the local test's 64–79 s. **Ad 2,** read by an Airi voice: $0.090, of which $0.080 Meta and $0.009 ElevenLabs text-to-speech; a later free render overwrote its first video's time |
| What one ad's AI action paid for | 1 Muse Spark call for the words, 3 Muse Image scenes, 3 Muse Spark same-product checks and 3 SAM 3.1 boxes, plus the text-to-speech when a voice reads it |
| WhatsApp kits | 1, on Nov 3: its order form was published as a WhatsApp Flow; its carousel failed on the old 10-second limit, before pull request 509, and was never sent to Meta. So Meta has approved no production carousel yet |
| Instagram posts, and Click-to-WhatsApp ads created paused on Facebook placements | 0 and 0: studio v3, which makes them, isn't live yet |
| Cloned voices | 0 |
