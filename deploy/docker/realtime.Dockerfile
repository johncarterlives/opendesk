# syntax=docker/dockerfile:1.7
#
# The realtime gateway: a Phoenix release on Debian slim, run as a nonroot user.
#
#   docker build -f deploy/docker/realtime.Dockerfile -t opendesk-realtime .
#
# The build context is the repo root, like every image here, so CI builds all
# of them the same way. Erlang has no cross compiler: multi-arch images are
# built on a native runner per architecture (see release.yml).
#
# The runtime Debian release (not its snapshot date) must match the builder's, or the crypto NIF fails
# to load against a different libssl.

ARG ELIXIR_VERSION=1.20.4
ARG OTP_VERSION=29.1.1
ARG DEBIAN_RELEASE=trixie
ARG DEBIAN_DATE=20261005
# The runtime stage is the one that ships, so it takes the newest snapshot (hexpm/elixir lags it).
ARG RUNTIME_DEBIAN_DATE=20261104

FROM hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_RELEASE}-${DEBIAN_DATE}-slim AS build
ARG RELEASE_NAME=realtime
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends build-essential git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force

COPY realtime/mix.exs realtime/mix.lock ./
RUN --mount=type=cache,id=hex,target=/root/.hex/packages \
    mix deps.get --only prod
# config/ before deps.compile: compile-time config changes have to rebuild deps.
COPY realtime/config config/
RUN mix deps.compile

# The rest of the app (lib, priv, rel). .dockerignore keeps deps and _build out.
COPY realtime/ ./
RUN mix compile && mix release "${RELEASE_NAME}" --overwrite

FROM debian:${DEBIAN_RELEASE}-${RUNTIME_DEBIAN_DATE}-slim
ARG RELEASE_NAME=realtime
ARG VERSION=dev COMMIT=none
LABEL org.opencontainers.image.title="opendesk-realtime" \
      org.opencontainers.image.description="The opendesk realtime gateway (Phoenix Channels over WebSocket)" \
      org.opencontainers.image.source="https://github.com/useopendesk/opendesk" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"

# zlib1g is named for its DSA-6613-1 fix, which the snapshot lacks. Drop it once RUNTIME_DEBIAN_DATE includes it.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 libsctp1 locales ca-certificates tini zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \
 && groupadd --system --gid 10001 realtime \
 && useradd --system --uid 10001 --gid realtime --home-dir /app --shell /usr/sbin/nologin realtime
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 \
    MIX_ENV=prod PHX_SERVER=true PORT=4000 \
    RELEASE_NAME=${RELEASE_NAME} RELEASE_TMP=/tmp \
    OPENDESK_RELEASE=${VERSION}

WORKDIR /app
COPY --from=build --chown=realtime:realtime /app/_build/prod/rel/${RELEASE_NAME} ./
COPY --chmod=0755 deploy/docker/realtime-entrypoint.sh /app/bin/entrypoint
COPY --chmod=0755 deploy/docker/realtime-healthcheck.sh /app/bin/healthcheck

USER realtime:realtime
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 \
  CMD ["/app/bin/healthcheck"]
# tini reaps zombies and forwards SIGTERM, so a stop drains sockets instead of
# being killed after the grace period.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/bin/entrypoint"]
CMD ["start"]
