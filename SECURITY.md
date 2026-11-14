# Security

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Instead, use GitHub's private vulnerability reporting, which is available under the Security tab as "Report a vulnerability". I will respond within seven days.

## Security measures

API keys are stored in `~/.omnitrix/secrets.json`. On macOS and Linux, the `~/.omnitrix` folder and the key file are readable only by your user account. To avoid storing a key at all, add the account with `--key-env`, and omnitrix will read the key from the environment each time. Error messages and the files attached to a task are masked for every key that the running omnitrix process has read for an account, and for values that match common key formats, such as `sk-`, `gsk-`, `fw_` and Google `AIza` keys, GitHub and AWS keys, JSON Web Tokens and Bearer tokens. Prompts and results are saved in `~/.omnitrix` without masking.

CLI logins remain inside each account's own profile folder. omnitrix starts the official tool with that folder and never reads, copies or uploads its contents.

Code tasks run in a separate git worktree. Before a worker starts, omnitrix deletes any agent settings included in the repository (`.claude`, `.mcp.json`, `.codex`, `.gemini`, `.qwen`, `.opencode`, `opencode.json`, `opencode.jsonc`, `.agy` and `.antigravity`), which prevents a repository from injecting hooks or MCP servers into a worker run. Other tasks that name a repository and go to an agent CLI run in a temporary copy of the repository at its last commit, with the same settings deleted, and the copy is removed when the task ends, so the worker does not work in your checkout. omnitrix sandboxes only Codex, which runs read-only for such tasks; another agent CLI that runs commands can still reach files outside its copy.

When omnitrix commits a code worker's changes, it uses the git folder that it recorded when it created the worktree, and it runs no git hooks and no file monitor. A worker that edits the `.git` file of its worktree therefore cannot make omnitrix run its commands.

When a task names a repository, omnitrix attaches only files inside it. omnitrix never attaches a file from `~/.omnitrix`, from `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh` or `~/.config/gcloud`, or, on Windows, from the GitHub CLI and gcloud folders in `AppData`. It also never attaches files named like credentials, such as `.env`, `.netrc`, `.npmrc`, `.git-credentials` or `id_ed25519`, wherever they are. Links are followed before these checks.

Agent CLIs start without the environment variables whose names suggest a key, token, secret or password, and without settings that would point them at another provider; only the account's own key is passed on. Requests to API providers do not follow redirects, so a key is sent only to the configured address, and an answer larger than 32 MB, or a model list larger than 4 MB, is refused. When a provider asks omnitrix to wait, through `Retry-After` or a reset header, omnitrix waits at most 24 hours.

Job ids that Claude passes to omnitrix must match the format that omnitrix uses for them, so an id can never name a file outside omnitrix's own folders. `omnitrix clean` deletes only files and worktrees inside those folders.

Prompts reach agent CLIs through standard input and never appear on the command line. Model names must match a strict pattern before they are passed on.

The dashboard listens only on 127.0.0.1 and rejects requests addressed to any other host name. It also rejects requests that a browser marks as coming from another website, and it does not allow other pages to show it in a frame. Its responses also forbid content-type sniffing.

On Windows, omnitrix does not run an agent program, such as `codex`, that is located in the current folder, so a cloned repository cannot substitute its own program.

## Supported versions

Security fixes are provided for the latest release only.
