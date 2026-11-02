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

- **It found the language every time.** Scribe named the right language for all 12 recordings, with a probability from 0.94 (Turkish) to 1.0 (Japanese), and for the 3 real Kazakh recordings below. Every word came with a start and an end time.
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
- Buyer drafts and the example names written into hidden lettering are in Kazakh, Russian or English, and in English for any other narration.
