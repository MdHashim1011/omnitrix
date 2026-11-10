# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting instead (Security tab, then "Report a vulnerability"). I'll reply within 7 days.

## What omnitrix does to keep you safe

API keys live in `~/.omnitrix/secrets.json`, which is readable only by you on macOS and Linux. If you'd rather not store a key at all, add the account with `--key-env` and omnitrix reads it from the environment each time. Keys are stripped from every error message, log line and job record.

CLI logins stay inside each account's own profile folder. omnitrix starts the official tool with that folder and never reads, copies or uploads the files in it.

Code tasks run in a separate git worktree. Before a worker starts, omnitrix deletes agent settings that came with the repository (`.claude`, `.mcp.json`, `.codex`, `.gemini`, `.qwen`), so a repo can't sneak hooks or MCP servers into a worker run.

Prompts reach agent CLIs on standard input, never on the command line, and model names have to match a strict pattern before they're passed on.

The dashboard listens on 127.0.0.1 only and answers nothing addressed to another host name.

## Supported versions

Only the latest release gets security fixes.
