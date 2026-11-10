# Security

## Reporting a problem

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). I will reply within 7 days.

## What omnitrix protects

- **API keys** are stored in `~/.omnitrix/secrets.json` (owner-only permissions on macOS and Linux) or read from environment variables with `--key-env`. They are redacted from every error message, log and job record.
- **CLI logins** stay inside each account's own profile folder. omnitrix never reads, copies or uploads those files.
- **Code tasks** run in a separate git worktree. Repo-provided agent settings (`.claude`, `.mcp.json`, `.codex`, `.gemini`, `.qwen`) are removed from the worker's copy so a task cannot run hooks shipped inside a repository.
- **Prompts** are passed to CLIs on standard input, never on the command line, and model names are checked against a strict pattern before use.
- **The dashboard** listens on 127.0.0.1 only and refuses requests for any other host name.

## Supported versions

Only the latest release gets security fixes.
