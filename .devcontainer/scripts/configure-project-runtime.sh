#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:/opt/flutter/bin:/opt/flutter/bin/cache/dart-sdk/bin:${PATH}"

if command -v corepack >/dev/null 2>&1; then
  corepack enable
fi

if [[ -f backend/pyproject.toml ]]; then
  printf 'Installing backend Python dependencies...\n'

  (
    cd backend
    uv sync
  )
fi

if [[ -f web/package-lock.json ]]; then
  printf 'Installing React dependencies with npm ci...\n'

  (
    cd web
    npm ci
  )
elif [[ -f web/package.json ]]; then
  printf 'Installing React dependencies with npm install...\n'

  (
    cd web
    npm install
  )
fi

if [[ -f app/pubspec.yaml ]]; then
  printf 'Installing Flutter dependencies...\n'

  (
    cd app
    flutter pub get
  )
fi

printf 'Project runtime configuration complete.\n'