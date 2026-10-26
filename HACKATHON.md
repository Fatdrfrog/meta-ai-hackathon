# Hackathon record

This repository is our entry to the Meta Global AI Developer Hackathon 2026, Startup track.

## What is new

Everything in this repository is new work, written between kickoff on Oct 26, 2026 and the deadline on Nov 4, 2026 at 9:00 PM ET.

The first two commits, made a few hours before kickoff, only set up the repository: this file, the README, the license and the commit-message rule. They have no product code.

## What already existed

[airi.chat](https://airi.chat), our WhatsApp customer-engagement product, existed before the hackathon. Its code is private and is not in this repository. Nothing here needs it: the demo runs from this repository alone, with synthetic data. The organizers confirmed this setup on Discord on Oct 26, 2026.

Where this project connects to airi.chat, the connection points are documented here, not copied.

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

## Meta models used

Filled in during the hackathon.
