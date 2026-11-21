# Image for agent runs in an Apple container (ADR-0051). Built locally by the gateway on first
# need (or `achords container build`); its tag is a hash of this file, so any change here gives
# a new image on the next run. Versions are pinned: update them here, never at run time.
FROM docker.io/library/node:22.23.5-bookworm-slim

# git for dev work, python3 for uvx-started MCP servers, certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.9 /uv /uvx /usr/local/bin/

# The official claude CLI, same version the host adapter was verified against.
RUN npm install -g @anthropic-ai/claude-code@2.1.328 && npm cache clean --force

# The CLI must not update itself inside a throwaway VM; the image pins it.
ENV DISABLE_AUTOUPDATER=1
WORKDIR /root
