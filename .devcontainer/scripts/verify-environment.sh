#!/usr/bin/env bash
set -euo pipefail

brief=false

if [[ "${1:-}" == "--brief" ]]; then
  brief=true
fi

export PATH="${HOME}/.local/bin:/opt/flutter/bin:/opt/flutter/bin/cache/dart-sdk/bin:${PATH}"
export CODE_INDEX_PATH="${HOME}/.code-index"

failures=0

check() {
  local label="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    printf 'PASS  %s\n' "${label}"
  else
    printf 'FAIL  %s\n' "${label}" >&2
    failures=$((failures + 1))
  fi
}

docker_ready() {
  local attempt

  for attempt in {1..30}; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

superpowers_available() {
  test -f \
    "${HOME}/.agents/skills/superpowers/using-superpowers/SKILL.md"
}

codex_extension_installed() {
  command -v code >/dev/null 2>&1 \
    && code --list-extensions 2>/dev/null \
      | grep -Fxiq 'openai.chatgpt'
}

check "Docker CLI installed" command -v docker
check "Inner Docker daemon available" docker_ready
check "Docker Compose available" docker compose version

check "Git installed" command -v git
check "SSH client installed" command -v ssh

check "Codex directory mounted" test -d "${HOME}/.codex"
check "Codex config available" test -s "${HOME}/.codex/config.toml"
check "Codex VS Code extension installed" codex_extension_installed

check "Superpowers linked" superpowers_available

check "jCodeMunch installed" command -v jcodemunch-mcp
check "jCodeMunch configuration valid" jcodemunch-mcp config --check

check "npm config uses environment token" \
  grep -Fq '${NPM_TOKEN}' "${HOME}/.npmrc"

check "Node.js installed" command -v node
check "npm installed" command -v npm
check "Corepack installed" command -v corepack

check "Python installed" command -v python
check "uv installed" command -v uv

check "Flutter installed" command -v flutter
check "Dart installed" command -v dart

check "Node.js executes successfully" node --version
check "npm executes successfully" npm --version
check "Python executes successfully" python --version
check "uv executes successfully" uv --version
check "Flutter executes successfully" flutter --version
check "Dart executes successfully" dart --version

check "Flutter analysis tooling available" flutter analyze --help

if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  check "SSH agent reachable" ssh-add -l
elif ! ${brief}; then
  printf '%s\n' \
    'WARN  SSH_AUTH_SOCK is not set; Git SSH authentication will not work yet.' \
    >&2
fi

if [[ -z "${NPM_TOKEN:-}" ]] && ! ${brief}; then
  printf '%s\n' \
    'WARN  NPM_TOKEN is empty; public npm packages work, but private packages will not.' \
    >&2
fi

if (( failures > 0 )); then
  printf '\n%d required check(s) failed.\n' "${failures}" >&2
  exit 1
fi

printf '\nAutonomous Codex Dev Container checks passed.\n'