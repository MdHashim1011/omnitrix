# Security

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Instead, use GitHub's private vulnerability reporting, which is available under the Security tab as "Report a vulnerability". I will respond within seven days.

## Security measures

API keys are stored in `~/.omnitrix/secrets.json`, which on macOS and Linux is readable only by your user account. To avoid storing a key at all, add the account with `--key-env`, and omnitrix will read the key from the environment each time. Error messages and job records are masked for values that match common key formats, such as `sk-` and `gsk-` keys and Bearer tokens. Keys in other formats might not be masked.

CLI logins remain inside each account's own profile folder. omnitrix starts the official tool with that folder and never reads, copies or uploads its contents.

Code tasks run in a separate git worktree. Before a worker starts, omnitrix deletes any agent settings included in the repository (`.claude`, `.mcp.json`, `.codex`, `.gemini`, `.qwen`), which prevents a repository from injecting hooks or MCP servers into a worker run.

Prompts reach agent CLIs through standard input and never appear on the command line. Model names must match a strict pattern before they are passed on.

The dashboard listens only on 127.0.0.1 and rejects requests addressed to any other host name.

## Supported versions

Security fixes are provided for the latest release only.
