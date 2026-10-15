#!/usr/bin/env bash
set -euo pipefail

readonly EXTENSIONS=(
  "openai.chatgpt"
  "ms-python.python"
  "ms-python.vscode-pylance"
  "ms-python.debugpy"
  "Dart-Code.dart-code"
  "Dart-Code.flutter"
  "dbaeumer.vscode-eslint"
  "esbenp.prettier-vscode"
  "ms-azuretools.vscode-containers"
)

if ! command -v code >/dev/null 2>&1; then
  printf 'The VS Code CLI is not available yet; devcontainer.json will install extensions.\n'
  exit 0
fi

installed_extensions="$(code --list-extensions 2>/dev/null || true)"

for extension in "${EXTENSIONS[@]}"; do
  if grep -Fxiq "${extension}" <<< "${installed_extensions}"; then
    printf 'PASS  VS Code extension installed: %s\n' "${extension}"
    continue
  fi

  printf 'Installing VS Code extension: %s\n' "${extension}"

  code \
    --install-extension "${extension}" \
    --force
done

printf '\nVS Code extensions configured.\n'