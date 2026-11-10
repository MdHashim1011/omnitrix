# Omnitrix

**One Claude brain, every AI account you have.**

omnitrix lets Claude Code act as the lead engineer while the actual work is spread across all the other AI accounts you already pay for or get for free: ChatGPT (through Codex), DeepSeek, Kimi, GLM, Qwen, MiniMax, Grok, Mistral, Groq, OpenRouter, Gemini API keys, your own Ollama models, and anything else that speaks the OpenAI or Anthropic API.

Claude plans the job, splits it into tasks, and omnitrix sends each task to the model that fits it best and still has quota left. Claude then reviews short results instead of doing every step itself, so your Claude limit lasts much longer.

```
                 ┌──────────────────────────────┐
  you  ───────►  │  Claude Code (plans, reviews) │
                 └──────────────┬───────────────┘
                                │ MCP
                 ┌──────────────▼───────────────┐
                 │  omnitrix                    │
                 │  router · quotas · job queue │
                 └─┬──────┬──────┬──────┬──────┬┘
                   │      │      │      │      │
                 Codex DeepSeek Kimi  Groq  Ollama ...
```

## What it does

- **Connects almost any provider.** Subscription CLIs (Codex, Claude Code, Qwen Code, Gemini CLI, Antigravity, OpenCode), hosted APIs (20+ built in), local runtimes (Ollama, LM Studio, llama.cpp, vLLM), and any custom OpenAI- or Anthropic-compatible URL.
- **Picks the right model for each task.** Every task has a type (code, review, reasoning, long reading, bulk work, writing, images). The router scores each model on skill fit, quota left, cost, past results and your privacy rules.
- **Learns.** When Claude accepts or rejects a result, omnitrix remembers which model did well at which kind of work and adjusts future choices.
- **Shows usage everywhere.** Every account's name, owner, requests, tokens and what's left, in Claude Code's status line, through a tool Claude can call, in the terminal, and on a local web dashboard. Numbers are labelled *measured* (the provider said so) or *estimated* (omnitrix counted).
- **Falls back automatically.** Rate limited, out of credits, logged out, or offline: the account is put on hold and the task moves to the next best account.
- **Keeps code work safe.** Code tasks run in their own git worktree and branch, so parallel workers never overwrite each other. Repo-provided agent hooks are stripped from the worker's copy.
- **Respects privacy.** Tasks are `private` by default and never go to providers that may train on prompts. `secret` tasks only run on models on your own machine.

## Install

Needs Node.js 20 or newer.

```bash
npm install -g github:MdHashim1011/omnitrix
```

Or from a clone:

```bash
git clone https://github.com/MdHashim1011/omnitrix.git
cd omnitrix
npm install
npm run build
npm link
```

## Quick start

```bash
# 1. see what you can connect
omnitrix providers

# 2. add accounts
omnitrix add ollama                                   # local models, found automatically
omnitrix add deepseek --key-env DEEPSEEK_API_KEY      # key read from an environment variable
omnitrix add groq --key gsk_xxx --label "Groq free"   # key saved in the omnitrix secrets file
omnitrix add codex --label "My ChatGPT Plus" --login  # signs in with the official Codex CLI

# 3. check them
omnitrix test deepseek
omnitrix list

# 4. plug it into Claude Code (MCP server + status line)
omnitrix setup-claude
```

Restart Claude Code and give it a big job. It sees the omnitrix tools and a short playbook on how to use them.

## Connecting accounts

| Kind | Example | Notes |
|---|---|---|
| Agent CLI with a subscription | `omnitrix add codex --login` | Each account gets its own profile folder, so several accounts of the same tool never mix. Can edit files. |
| Hosted API key | `omnitrix add kimi --key-env MOONSHOT_API_KEY` | Models are discovered from the provider's `/models` endpoint. |
| Anthropic-format endpoint | `omnitrix add glm --anthropic --key-env ZAI_API_KEY` | DeepSeek, Kimi, GLM and MiniMax all offer one. |
| Coding plan through Claude Code | `omnitrix add claude-code --base-url https://api.z.ai/api/anthropic --key-env ZAI_API_KEY` | Drives a GLM / Kimi / MiniMax coding plan as a file-editing agent. |
| Local model | `omnitrix add ollama` | Free, private, works offline. |
| Anything else | `omnitrix add custom-openai --base-url https://my-host/v1 --key-env MY_KEY --model my-model` | |

Useful options for `add` and `set`:

- `--owner <name>` who the account belongs to (shown everywhere)
- `--rpm / --r5h / --rpd / --rpw / --tpd / --tpm <n>` limits per minute, 5 hours, day, week, tokens per day, tokens per month. omnitrix counts usage against them and shows what is left.
- `--concurrency <n>` how many jobs may run on the account at once
- `--trains-on-data` mark a provider that may use prompts for training (keeps private tasks away)

Keys are never printed. Use `--key-env` if you would rather not store a key on disk at all.

## How Claude uses it

omnitrix is an MCP server with these tools:

| Tool | What it does |
|---|---|
| `pool_status` | All accounts, their state, owner, models, used and remaining quota |
| `route_preview` | Who would get each task and why, without running anything |
| `dispatch` | Send up to 30 tasks; independent tasks run in parallel |
| `get_results` | Wait for jobs and get short previews of the results |
| `read_output` | Page through a full result when the preview is not enough |
| `rate_result` | Accept or reject a result; the router learns from it |
| `cancel_job` / `list_jobs` | Manage jobs |

Results are kept short on purpose (1,500 characters by default) so reading them costs Claude very little. Full outputs are saved on disk.

## Routing

Each model has six scores from 0 to 10: coding, reasoning, writing, long context, vision and speed. They start as a guess based on the model name. You can set them yourself:

```bash
omnitrix models deepseek
omnitrix model deepseek deepseek-v4-pro --coding 9 --reasoning 9
```

For each task the router:

1. drops accounts that are disabled, banned, logged out, cooling down, out of quota, or not allowed by the privacy level
2. scores the rest: skill fit × quota left × cost × past acceptance rate
3. tries the best free account, and moves down the list if it fails

You can steer it:

```bash
omnitrix settings --mode saver                 # prefer free and cheap models
omnitrix settings --mode quality               # prefer the strongest models
omnitrix settings --pin code=codex-main        # always try this account first for code
omnitrix settings --ban mistral                # never use a provider
omnitrix route --type reasoning "plan a database migration"   # see the ranking
```

## Usage tracking

Most subscription plans do not publish exact limits or offer an API for "how much is left". omnitrix is honest about that:

- When a provider sends rate-limit headers, those numbers are used and shown as **measured**.
- Otherwise omnitrix counts every request and token it sends and compares them with the limits you set. Those numbers are **estimated**.
- A `429` or `402` from the provider is always treated as the real signal, whatever the counters say.

```bash
omnitrix list         # terminal view
omnitrix dashboard    # live web view at http://127.0.0.1:4590
```

The status line shows something like:

```
omnitrix 4/5 ready · codex-main 62% · deepseek 812 left · groq wait · ollama 3req │ Claude 5h 34% 7d 12%
```

## Privacy levels

| Level | Where it can run |
|---|---|
| `public` | any connected provider |
| `private` (default) | providers not marked as training on prompts |
| `secret` | only models on this machine |

## Where data lives

Everything is stored in `~/.omnitrix` (override with `OMNITRIX_HOME`): `config.json`, `secrets.json`, `usage.jsonl`, job records, outputs, CLI profile folders and worktrees. Nothing is sent anywhere except to the providers you connect. There is no telemetry.

## Terms of service

omnitrix drives official CLIs and APIs with your own credentials. It does not import or move anyone else's login, and it never will. Please read the rules of each provider you connect:

- **Account sharing is not allowed** by OpenAI, Google or Anthropic consumer terms. Connect accounts you own. If a friend wants to help, the safest way is for them to give you an API key billed to them, which most API terms allow.
- **Anthropic** allows Claude Code subscriptions for ordinary individual use only. Use your own account.
- **Google** has suspended accounts that used Antigravity or Gemini sign-in through outside tools. omnitrix marks Antigravity as experimental. Gemini API keys are the safe route.
- **Free tiers** often have per-organization limits and may use prompts for training. omnitrix does not try to multiply free quotas.

omnitrix is an independent project. It is not affiliated with OpenAI, Google, Anthropic, any other AI provider, or Cartoon Network and Warner Bros. Discovery. All product names and trademarks belong to their owners.

## Command reference

```
omnitrix providers              list providers you can connect
omnitrix add <provider> [opts]  connect an account
omnitrix login <id>             sign in a CLI account in its own profile
omnitrix list                   accounts with usage and what is left
omnitrix test <id>              send a tiny request to check an account
omnitrix set <id> [opts]        change limits, owner, key, concurrency
omnitrix enable|disable <id>    turn an account on or off
omnitrix remove <id> [--purge]  remove an account
omnitrix models <id>            show model scores (--refresh to re-discover)
omnitrix model <id> <model>     set scores or prices, --add / --remove
omnitrix route <prompt>         show which model would get a task
omnitrix run <prompt>           run one task and print the answer
omnitrix settings [opts]        mode, privacy, pins, bans, timeouts
omnitrix dashboard              live web dashboard
omnitrix statusline             one-line summary for Claude Code
omnitrix setup-claude           register in Claude Code + status line
omnitrix mcp                    run the MCP server
omnitrix doctor                 check the setup
```

## Development

```bash
npm install
npm run build
npm test
```

Tests run against fake providers and a fake agent CLI, so they need no keys or network.

## Roadmap

- Friend nodes: a small agent a friend runs on their own machine, with their own login, daily caps, a schedule and a pause switch. Credentials never leave their computer.
- Cross-model review for critical tasks
- More CLI drivers (Goose, Aider, Cline)
- Live quota readers for providers that expose balance endpoints

## License

Apache-2.0. Copyright 2026 Mohamed Hashim.
