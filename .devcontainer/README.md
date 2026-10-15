# Dev Container Details

This directory is designed to be copied into another repository unchanged and then extended for that project's runtimes and services.

## Security boundary

Codex Full Access controls the Dev Container, including its isolated inner Docker daemon. It does not receive the host Docker socket or SSH private-key files.

The outer Dev Container is privileged because Docker-in-Docker requires elevated container capabilities. Treat the source workspace and forwarded credentials as accessible to the coding agent.

## Mounted host configuration

The following Linux/WSL host paths must exist before reopening the project in the Dev Container:

```text
~/.codex/config.toml
~/.agents/skills/superpowers/
~/.code-index/
```

They are mounted read-only under `/opt/host-agent-config`. Startup scripts copy configuration into writable project-specific state and link the Superpowers skill directory.

## Persistent project state

Named-volume prefixes are based on `${localWorkspaceFolderBasename}`:

```text
<project>-dind-data
<project>-codex-state
<project>-jcodemunch-state
```

Repositories with identical directory names share these volumes. Rename one directory or customize the volume names when strict separation is required.

## Adding project runtimes

Extend the `features` object in `devcontainer.json`. For example, a project can add Node, Python, Go, Rust, Java, or other official features without changing this base repository.

After modifying the Dev Container configuration, run **Dev Containers: Rebuild Container**.
