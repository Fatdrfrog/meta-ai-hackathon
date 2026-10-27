# Hackathon record

This repository is our entry to the Meta Global AI Developer Hackathon 2026, Startup track.

## What is new

Everything in this repository outside the `airi/` folder is new work, written between kickoff on Oct 26, 2026 and the deadline on Nov 4, 2026 at 9:00 PM ET.

The first two commits, made a few hours before kickoff, only set up the repository: this file, the README, the license and the commit-message rule. They have no product code.

## What already existed

[airi.chat](https://airi.chat), our WhatsApp customer-engagement product, existed before the hackathon. **The `airi/` folder is airi.chat as it was before this event, not hackathon work.**

- It came in one commit, `meta-ai-hackathon: import airi.chat as pre-existing code (not hackathon work)`, taken from airi.chat's private main branch at commit `c81f9d812` (Oct 27, 2026).
- In that commit, only these changes were made to airi.chat's code:
  - database migrations, internal docs and AI-tool folders were removed;
  - customer names, a team member's email and real-looking phone numbers in tests were replaced with neutral values;
  - one demo data file moved next to the code that reads it.
- Hackathon work inside `airi/` arrives only in later commits, and each one is listed under "Features built" below. `git log -- airi` shows every change after the import.

## How to check

- Every commit subject starts with `meta-ai-hackathon: `. A local hook ([.githooks/commit-msg](.githooks/commit-msg)) and a CI check ([.github/workflows/commit-convention.yml](.github/workflows/commit-convention.yml)) enforce it.
- Full history: <https://github.com/Fatdrfrog/meta-ai-hackathon/commits/main>

## Features built

Filled in during the hackathon.

| Feature | Commits | Meta models used |
| ------- | ------- | ---------------- |
| Meta Model API client with a hard spend cap, SAM 3.1 video tracking, first video experiments | `meta-ai-hackathon: Meta Model API client, spend cap and video spikes` | Muse Spark 1.3, SAM 3.1 |
| Video to catalog cut-outs: per-product SAM on the sharpest frame, mask cut-outs; findings on Muse Spark audio | `meta-ai-hackathon: per-product SAM cut-outs and first findings` | Muse Spark 1.3, SAM 3.1 |
| Speech harness scoring models against the owner's real prices; ElevenLabs Scribe chosen for listening | `meta-ai-hackathon: speech harness scored against real prices`, `meta-ai-hackathon: choose ElevenLabs Scribe for speech` | Muse Spark 1.3, Muse Spark Open (compared) |
| Catalog pipeline: transcript-grounded inventory, prices verified word for word against the narration, SAM cut-outs | `meta-ai-hackathon: catalog pipeline with prices verified against the narration` | Muse Spark 1.3, SAM 3.1 |
| Owner studio (upload, live progress, shelf review with the owner's own words, confirm) and public shop page; server with a SQLite job queue | `meta-ai-hackathon: owner studio and shop page` | Muse Spark 1.3, SAM 3.1 (through the pipeline) |
| Tracked cut-outs: Muse Spark picks a frame and boxes the product, SAM 3.1 tracks it through the product's clip, code chooses the frame by measuring each mask, hands subtracted; 7/7 clean on the test video | `meta-ai-hackathon: tracked cut-outs chosen by measuring SAM's masks` | Muse Spark 1.3, SAM 3.1 (video tracking) |
| AI seller: answers in the buyer's language, matches buyer photos, takes orders, passes unknowns to the owner; prices and orders checked in code; scripted evaluation 8/8 | `meta-ai-hackathon: AI seller on Muse Spark Open with checked prices` | Muse Spark Open (open weights, Baseten) |
| Chat on the shop page (product cards, photo upload, order receipt, rate limits) and the studio's orders and buyer questions | `meta-ai-hackathon: shop page chat with orders and questions in the studio` | Muse Spark Open (open weights, Baseten) |
| Seller as a tool-calling agent: searches the shelf, matches photos, shows cards, places and looks up orders, asks the owner; tools check its actions, code checks its prices (bare amounts too); evaluation 9/9 | `meta-ai-hackathon: seller as a tool-calling agent on Muse Spark Open` | Muse Spark Open (open weights, Baseten) |

## Meta models used

Filled in during the hackathon.
