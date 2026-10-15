FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG FLUTTER_CHANNEL=stable
ARG FLUTTER_HOME=/opt/flutter

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        curl \
        file \
        git \
        jq \
        less \
        libffi-dev \
        libglu1-mesa \
        libgtk-3-dev \
        libjpeg-dev \
        libpq-dev \
        libssl-dev \
        libstdc++-12-dev \
        libwebp-dev \
        nano \
        ninja-build \
        openssh-client \
        pkg-config \
        ripgrep \
        shellcheck \
        sudo \
        unzip \
        wget \
        xz-utils \
        zip \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv and uvx as standalone binaries. This does not depend on the
# Python Dev Container Feature being installed yet.
COPY --from=ghcr.io/astral-sh/uv:latest \
    /uv \
    /uvx \
    /usr/local/bin/

# Install Flutter directly from the stable channel.
RUN git clone \
        --depth 1 \
        --branch "${FLUTTER_CHANNEL}" \
        https://github.com/flutter/flutter.git \
        "${FLUTTER_HOME}" \
    && chown -R vscode:vscode "${FLUTTER_HOME}"

ENV PATH="/home/vscode/.local/bin:${FLUTTER_HOME}/bin:${FLUTTER_HOME}/bin/cache/dart-sdk/bin:${PATH}"
ENV UV_TOOL_BIN_DIR="/home/vscode/.local/bin"
ENV CODE_INDEX_PATH="/home/vscode/.code-index"

USER vscode

RUN flutter config \
        --no-analytics \
        --enable-web \
    && dart --disable-analytics \
    && flutter precache --web

USER root