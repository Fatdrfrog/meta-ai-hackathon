FROM node:24-bookworm-slim

ARG _IMAGE_SOURCE_COMMIT=unknown
ARG _BUILD_CONTEXT_SHA256=unknown
ARG _REQUESTS_WRITER_PROTOCOL=sequence_v2
ARG _MINIMUM_COMPATIBLE_BUILD=requests-sequence-v2-a
LABEL org.opencontainers.image.revision="${_IMAGE_SOURCE_COMMIT}" \
      airi.requests.writer-protocol="${_REQUESTS_WRITER_PROTOCOL}" \
      airi.build-context.sha256="${_BUILD_CONTEXT_SHA256}" \
      airi.minimum-compatible-build="${_MINIMUM_COMPATIBLE_BUILD}"

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive DEBCONF_NOWARNINGS=yes apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libgl1 libglib2.0-0 libgomp1 python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/temporal-worker/media-runners/requirements.txt apps/temporal-worker/media-runners/requirements.txt
RUN python3 -m venv /opt/airi-media \
  && /opt/airi-media/bin/pip install --no-cache-dir -r apps/temporal-worker/media-runners/requirements.txt \
  && mkdir -p apps/temporal-worker/media-runners/models \
  && curl -fsSL -o apps/temporal-worker/media-runners/models/selfie_segmenter.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite

# Node.js 25 no longer bundles Corepack, so install the package manager
# directly from the repo's packageManager field instead of relying on `corepack enable`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN PACKAGE_MANAGER="$(node -p 'require("./package.json").packageManager')" \
  && npm install --global "$PACKAGE_MANAGER"
# Fetch from the lockfile so changing runtime source does not redownload dependencies.
# pnpm owns workspace membership; no parallel list of workspace manifests is needed.
RUN pnpm fetch

# Copy the monorepo because the worker dynamically imports web runtime code
# from apps/web at execution time.
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @icecore/temporal-worker build:workflow-bundle

ENV NODE_ENV=production
ENV PATH="/opt/airi-media/bin:${PATH}"

CMD ["pnpm", "--filter", "@icecore/temporal-worker", "start"]
