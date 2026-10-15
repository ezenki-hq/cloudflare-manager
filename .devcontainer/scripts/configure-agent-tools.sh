#!/usr/bin/env bash
set -euo pipefail

readonly USER_HOME="${HOME:-/home/vscode}"
readonly CODEX_HOME="${USER_HOME}/.codex"
readonly AGENTS_HOME="${USER_HOME}/.agents"
readonly SKILLS_HOME="${AGENTS_HOME}/skills"
readonly CODE_INDEX_HOME="${USER_HOME}/.code-index"
readonly LOCAL_BIN="${USER_HOME}/.local/bin"

export PATH="${LOCAL_BIN}:/opt/flutter/bin:/opt/flutter/bin/cache/dart-sdk/bin:${PATH}"
export UV_TOOL_BIN_DIR="${LOCAL_BIN}"
export CODE_INDEX_PATH="${CODE_INDEX_HOME}"

ensure_directory() {
  local directory="$1"
  local mode="${2:-0755}"

  mkdir -p "${directory}"
  chmod "${mode}" "${directory}"
}

ensure_directory "${AGENTS_HOME}" 0755
ensure_directory "${SKILLS_HOME}" 0755
ensure_directory "${CODE_INDEX_HOME}" 0700
ensure_directory "${LOCAL_BIN}" 0755

if [[ ! -d "${CODEX_HOME}" ]]; then
  printf 'Missing mounted Codex directory: %s\n' "${CODEX_HOME}" >&2
  exit 1
fi

if [[ ! -s "${CODEX_HOME}/config.toml" ]]; then
  printf 'Missing mounted Codex configuration: %s/config.toml\n' \
    "${CODEX_HOME}" >&2
  exit 1
fi

configure_superpowers() {
  local skill_file
  local skills_root

  skill_file="$(
    find "${CODEX_HOME}/plugins" \
      -type f \
      -path '*/using-superpowers/SKILL.md' \
      -print \
      -quit \
      2>/dev/null || true
  )"

  if [[ -z "${skill_file}" ]]; then
    printf '%s\n' \
      'Superpowers was not found under the mounted ~/.codex/plugins directory.' \
      'Open Codex outside the container once and verify that the Superpowers plugin is installed.' \
      >&2
    return 1
  fi

  # The directory containing using-superpowers and the other skills.
  skills_root="$(dirname "$(dirname "${skill_file}")")"

  rm -rf "${SKILLS_HOME}/superpowers"

  ln -s \
    "${skills_root}" \
    "${SKILLS_HOME}/superpowers"

  printf 'Superpowers linked from: %s\n' "${skills_root}"
}

install_jcodemunch() {
  if command -v jcodemunch-mcp >/dev/null 2>&1; then
    printf 'jCodeMunch is already installed: %s\n' \
      "$(command -v jcodemunch-mcp)"
    return
  fi

  printf 'Installing jCodeMunch...\n'

  uv tool install \
    --force \
    "jcodemunch-mcp[local-embed]"

  hash -r

  if ! command -v jcodemunch-mcp >/dev/null 2>&1; then
    printf 'jCodeMunch installation completed but its command is not on PATH.\n' >&2
    exit 1
  fi
}

configure_jcodemunch_mcp() {
  local config_file="${CODEX_HOME}/config.toml"
  local executable

  executable="$(command -v jcodemunch-mcp || true)"

  if [[ -z "${executable}" ]]; then
    printf 'jCodeMunch executable was not found on PATH.\n' >&2
    exit 1
  fi

  # Remove the existing block so its command can be corrected.
  python - "${config_file}" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()

pattern = re.compile(
    r"\n?\[mcp_servers\.jcodemunch\]\n"
    r"(?:(?!\n\[[^\]]+\]).)*",
    re.DOTALL,
)

text = pattern.sub("", text).rstrip() + "\n"
path.write_text(text)
PY

  cat >> "${config_file}" <<TOML

[mcp_servers.jcodemunch]
type = "stdio"
command = "${executable}"
args = []
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
TOML

  printf 'Configured jCodeMunch MCP with executable: %s\n' "${executable}"
}

configure_npm() {
  cat > "${USER_HOME}/.npmrc" <<'NPMRC'
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
always-auth=true
NPMRC

  chmod 0600 "${USER_HOME}/.npmrc"
}

configure_superpowers
install_jcodemunch
configure_jcodemunch_mcp
configure_npm

printf '\nAgent tools configured.\n'