# omnitrix

Claude plans the work, and your other AI accounts carry it out.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/job-v3-dark.svg">
  <img alt="An example job, 'add rate limiting to the public API', split by Claude into six tasks in two rounds. First, Gemini reads the exported issues, Codex writes the middleware on its own git branch, Groq drafts the changelog and a local Ollama model checks the .env file for leaked keys. Then DeepSeek reviews the middleware diff, and the edge-case task moves to GLM because Kimi is rate limited. Claude checks each result and merges the accepted branch." src="assets/job-v3-light.svg" width="100%">
</picture>

I built omnitrix because I repeatedly ran out of Claude credits while the ChatGPT Plus and Gemini subscriptions that my friends and I pay for remained largely unused.

omnitrix is built for the frontier-model subscriptions and API keys you already pay for, and it runs inside your existing Claude Code session. Claude remains in charge: it divides the job into tasks and reviews the results. omnitrix sends each task to an account that suits the work and still has quota available. For example, it can use Codex on your ChatGPT plan for code edits, Gemini for reading very large logs, DeepSeek or Kimi for reasoning and review, or a local model for private work. It also supports any service that implements the OpenAI Chat Completions format or the Anthropic Messages format, through `custom-openai` and `custom-anthropic`.

You can monitor the pool without leaving Claude Code. The status line shows up to four accounts with their remaining quota or status, and omnitrix instructs Claude to check the same data before it assigns work. Claude reads short results instead of performing every step itself, which uses less of your Claude usage limit.

## Installation

omnitrix requires Node.js 20 or later.

```bash
npm install -g https://github.com/MdHashim1011/omnitrix/releases/latest/download/omnitrix.tgz
```

Each release from version 0.1.21 onward also includes `omnitrix.tgz.sha256`, the SHA-256 checksum of the package. To check a download before installing it, download both files from the release page and compare the checksum with the one that your computer calculates:

```bash
certutil -hashfile omnitrix.tgz SHA256
shasum -a 256 omnitrix.tgz
```

The first command is for Windows and the second for macOS and Linux. The value it prints must match the one in `omnitrix.tgz.sha256`. Then install the file you checked with `npm install -g ./omnitrix.tgz`.

## Quick start

```bash
omnitrix init
omnitrix init --apply
omnitrix setup-claude
```

`omnitrix init` lists the agent CLIs that omnitrix supports and finds on your PATH, the API keys set in the environment variables that `omnitrix providers` names (for example `DEEPSEEK_API_KEY`), and the local model servers that answer at their default addresses. It also shows which of them are already connected. Without `--apply`, it does not create or change anything. With `--apply`, it connects each new one in the same way as `omnitrix add <provider>` with no other options. It shows only the names of environment variables, never their values. For API keys, it stores a reference to the environment variable rather than the key itself, so the variable must also be set where Claude Code starts omnitrix. When it finishes, it opens the dashboard in your default browser, even if nothing is connected yet; use `--no-open` to skip this. It does not open a second tab when one is already open, and it does not start the dashboard when `CI` or `OMNITRIX_NO_BROWSER=1` is set.

It lists some tools without adding them: Claude Code, because Claude Code leads the work and would spend the same Claude quota as a worker; Google Antigravity, because Google has suspended accounts used through outside tools; and the Gemini CLI while `GEMINI_API_KEY` is not set, because it cannot run without a key. After `--apply`, CLI accounts that do not use an API key, such as Codex, OpenCode and Qwen Code, need `omnitrix login <id>` once before they can run jobs.

To connect accounts one at a time instead:

```bash
omnitrix providers
omnitrix add ollama
omnitrix add deepseek --key-env DEEPSEEK_API_KEY
omnitrix add codex --label "My ChatGPT Plus" --login
omnitrix test deepseek
omnitrix setup-claude
```

These commands list the available providers, add your local Ollama models and a DeepSeek key, sign in to Codex with your ChatGPT plan, confirm that DeepSeek responds, and register omnitrix with Claude Code as both an MCP server and a status line.

Restart Claude Code and give it a substantial task, such as "add tests for the billing module and document the API". Claude receives the omnitrix tools along with brief instructions on when to delegate work.

## How tasks are routed

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/routing-v3-dark.svg">
  <img alt="An example: a review task marked private. Kimi is skipped because it is cooling down, and Mistral because it may train on prompts. The rest are scored on fit, quota left, cost and past results. DeepSeek scores highest and gets the task, with GLM and Codex as fallbacks." src="assets/routing-v3-light.svg" width="100%">
</picture>

Every task that Claude sends has a type, such as code, review or bulk work, and a privacy level. omnitrix first excludes any account that cannot accept the task at that moment because it is:

- disabled, signed out or banned in settings
- cooling down after a rate limit, offline, or out of quota for the current window
- not permitted to receive the task: private work never goes to an account that may train on prompts while private protection is on, and secret work goes only to local models at an address on this computer (`localhost`, `127.x.x.x` or `::1`), never to a model whose name ends in `-cloud` or `:cloud`
- unable to do the task, such as a model that cannot read images

A model that is resting after errors is skipped, while the account's other models remain available. An account that fails three times in a row within ten minutes, through network errors, server errors, timeouts or unknown errors, rests for ten minutes. Rate limits, exhausted quota and sign-in problems are handled separately and do not count towards this. When `pool_status` or the dashboard shows the pool, omnitrix also asks each local model server, such as Ollama, for its model list at most once every 30 seconds, and shows a server that does not answer as offline for 60 seconds, during which the router skips it. Other failures rest the whole account for a short time: 60 seconds after a network error (30 seconds for a local server), 30 seconds after a server error on an account with only one model, and 60 seconds after a rate limit unless the provider names a time. Server errors and timeouts that all come from one model only pause that model, so they do not rest an account that has other models.

Each remaining model receives a score based on how well it fits the task, how much quota the account has left, what the model costs, and how often its past work was accepted. An account without a known limit, such as a local model or an API key with no limits set, is counted as having 80% left, so that it ranks just below a fresh account whose quota is known; `omnitrix route` shows this as "no known limit". An account that is already running as many jobs as its concurrency limit allows has its score halved. The highest-scoring model receives the task. If that call fails, omnitrix ranks the accounts again, skips those it has already tried, and passes the task on without any action from Claude. After a timeout or a server error, the same account stays eligible with another of its models. A job makes at most three attempts, and at most twelve tries in total when retired models are included. A request that the provider rejects as invalid, including an `effort` value that the model does not accept, fails the job without another attempt, and so does an answer that arrived but could not be saved. A model that the provider no longer serves, or for which the plan has no allowance, is removed from the account and rests for 24 hours, and trying it does not count as an attempt.

Three further adjustments multiply that score. Each adjustment that applies is listed in the reasons shown by `omnitrix route`, which lists the top eight candidates, and by `route_preview`, which lists the top three:

- If a window that the provider reports with a reset time resets within the next hour, and the account still has at least 20% left in its tightest window, the score is multiplied by 1.25 so that the quota is used before it is lost. Windows that omnitrix counts itself have no reset time, so this applies only to providers that report their own windows, such as ChatGPT through Codex.
- If an account is forecast to run out of a window before it resets, as described under "Monitoring quota", the score is multiplied by 0.75 so that the account keeps some quota in reserve. This takes precedence over the previous adjustment.
- For a public task, a model with no price set, on an account that may train on prompts, has its score multiplied by 1.15. Such an account can only take public work, so giving it that work first leaves the other accounts' quota for private tasks. This does not apply in quality mode.

Together these adjustments can raise a score by about 44% or lower it by 25%, so they can change the order of models whose fit for the task is similar. A pin adds a large fixed amount, so in practice pinned accounts rank above all others, but the adjustments can change the order among pinned accounts.

Code tasks go only to agent CLIs that can edit files. Each task runs on a new branch in its own git worktree, so two workers never share a checkout. Other tasks that name a repository and go to an agent CLI run in a temporary copy of the repository that is removed afterwards, so a reviewing worker does not work in your checkout. The copy is taken at the last commit, and the files that the task lists are copied into the prompt from your working tree, including changes that are not committed.

After a code task, omnitrix checks the branch itself rather than relying on the worker's report. It lists the files that the worker changed and, when the task named its files, the changed files that the task did not name. When the task gives a `test` command, such as `["npm", "test"]`, omnitrix runs it in the job's worktree after the worker finishes and reports whether it passed, its exit code and the end of its output, without terminal colour codes. The worktree is a fresh copy without installed packages, so for a Node.js project use `["npm", "install-test"]`, which installs them before it runs the tests. `get_results` waits for the test, and the dashboard shows the result on each job as "Checked by omnitrix". The test runs the worker's code on your computer, without keys in its environment, with an empty home folder of its own and with its own time limit, equal to the job limit but at most one hour; `cancel_job` stops it when it runs in the same omnitrix process. omnitrix never merges anything: Claude still reviews the work, and you decide what to keep.

An account's concurrency limit applies to all omnitrix processes that share the same data folder, such as the MCP server, the dashboard and the command line. It is 1 by default for agent CLIs and local models and 2 for APIs, and `omnitrix set <id> --concurrency` changes it. When the best account is full, the job goes to the next eligible account that has a free slot, and it waits in the queue only when every eligible account is full. The limit does not apply across different computers, and `omnitrix test` does not count towards it.

A request to an API model may take up to 2 minutes for a small task, 5 minutes for a medium one and 10 minutes for a large one, and never longer than the job limit, which is 900 seconds unless you change it with `omnitrix settings --timeout`. A task's `size` is medium unless Claude sets it, and it also caps the answer of an API model at 4,000, 16,000 or 32,000 tokens. Agent CLIs such as Codex may use the whole job limit, because they work in many steps. When a model times out, returns a server error or returns an empty answer, that model is paused for 5 minutes, and the job continues on other accounts or models. An agent CLI that exits with an error code has failed, even if it printed an answer first.

Skill scores are starting points, not measurements, and `omnitrix models <id>` shows where each set comes from: `untested` when omnitrix knows nothing about the model, `estimated` when the scores are guessed from the model's name or from what the server reports, and `manual` when you set them yourself. For a local model, only the size and a specialty such as "coder" in its name count, because a local name can be anything; Ollama models are scored from the size and capabilities that Ollama reports and from a specialty in the name; a model that Ollama does not list receives the plain local scores. Text files that a task lists are copied into the prompt up to 400,000 characters in total, from at most 50 files. For `review` and `reasoning` tasks each line starts with its line number, so that a finding can name the line; other task types receive the text unchanged, so that numbers do not end up in a translation or in code. A hosted model is treated as reading images when its name suggests it or when you set a vision score of 5 or more; a local model is treated as reading images only when the server reports it or when you set its scores yourself. A `vision` task sends the pictures among its files (PNG, JPEG, GIF or WebP, up to four files of at most 3.75 MB each, which is about 5 MB after encoding; larger or additional pictures are not sent) with the request, so it goes only to API and local models, never to agent CLIs.

omnitrix also adjusts its ranking over time: when Claude accepts or rejects a result, the model's record for that type of task is updated, and `omnitrix models` shows how many rated jobs each model has had and how many of them were accepted; the weight of a verdict halves every 30 days, the figures are rounded, and the past-results factor in the router's reasons ranges from 0.6 to 1.4. A later verdict on the same job replaces the earlier one instead of counting twice. For Ollama models that report a version digest, the record belongs to that exact version, so after `omnitrix models <id> --refresh` a new model pulled under the same name starts without the old record. Models that the router picks more often collect verdicts sooner, so an acceptance rate based on a few jobs says little.

```bash
omnitrix models deepseek
omnitrix model deepseek deepseek-v4-pro --coding 9 --reasoning 9
omnitrix route --type review "check this diff for auth bugs"
```

## Monitoring quota

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/dashboard-4k-dark.png">
  <img alt="The omnitrix dashboard with example data: six accounts, with quota meters where limits are known, one resting after a rate limit and one that needs sign-in, and the latest jobs with their results, including omnitrix's own check of a code job." src="assets/dashboard-4k-light.png" width="100%">
</picture>

<sub>The dashboard, shown with example data. Run `omnitrix dashboard` to open your own.</sub>

`omnitrix dashboard` starts the dashboard in the background, or finds the one already running, and opens it in your default browser unless a dashboard tab is already open. The page updates by itself when accounts or models are added or removed, when jobs change state and when usage or quota changes. If the connection drops or the dashboard restarts, the page reconnects on its own and shows the time of the last update until it is live again. `omnitrix dashboard --stop` stops it. Installing an update does not stop a dashboard that is already running, so when Claude Code next starts omnitrix, omnitrix replaces a background dashboard of an older version with its own, without opening a tab; open pages reconnect by themselves. A dashboard of a newer version is left running. In the same way, omnitrix starts the dashboard again when it stopped without `omnitrix dashboard --stop`, for example after a restart of the computer. On Windows the dashboard is started outside the process tree of the program that started it, so closing Claude Code does not close the dashboard. In the Claude desktop app, Claude can open the same address in its own browser pane, because `pool_status` reports the dashboard address while it is running.

The dashboard shows each account's name, owner, usage in the last 24 hours and the quota remaining in each tracked window. When the provider's own numbers cannot be read again, it keeps the last ones, shows when they were read, and marks them as possibly out of date. In Claude Code, the status line gives a compact summary of up to four accounts. The Claude figures at the end appear when Claude Code provides them, which it does on Pro and Max plans:

```
omnitrix 5/6 ready · codex-main 38% · deepseek 788 left · kimi wait · groq-free 36% +2 │ Claude 5h 34% 7d 12%
```

Account percentages show the share remaining, and the Claude figures show the share used.

Most subscriptions neither publish exact limits nor provide a way to query the remaining allowance, so omnitrix states the source of each figure. For a ChatGPT plan, it queries Codex directly and shows the percentage remaining in each window that Codex reports, usually 5 hours and 7 days, along with the time each window resets. This query ignores any API key exported in your environment, so the figures always belong to the account's own plan. When a provider sends rate-limit headers, omnitrix reports the remaining requests in the status line and in `pool_status`. In all other cases, it counts the requests and tokens it has sent against the limits you configured. A `402` response, or a `429` response that mentions quota or billing, marks the account as out of quota until the provider's reset time, or for one hour when the provider gives no time. Any other `429` pauses the account until the time in `Retry-After`, or for 60 seconds, and a `429` that reports `limit: 0` pauses only that model, for 24 hours. These waits never exceed 24 hours, whatever the count shows.

omnitrix also estimates when a window will run out if use continues at its current pace. For the windows that Codex reports for a ChatGPT plan, the pace is the share used between the opening of the window and the latest reading, and an estimate is possible once the window has been open for at least 15 minutes, or for at least a day in the case of the weekly window, because one large job early in a week does not show a pace. For the 5-hour and 24-hour limits that omnitrix counts itself, the pace is the number of requests, or tokens, sent in the last hour, and an estimate is possible once at least three requests were sent in that hour. Weekly, monthly and one-minute limits are not estimated, because a single hour says little about them. An estimate is shown only when it falls before the window resets or, for a rolling window, within the length of the window. The estimate is a straight-line projection that does not account for older use leaving a rolling window, so it is a warning rather than a prediction. In `pool_status` it reads, for example, "runs out in about 1 h 7 min at this pace", and the dashboard shows "At this pace it runs out in about 1 h 7 min", followed by the time.

## Privacy

Tasks are `private` by default, which keeps them away from accounts flagged as possibly training on prompts. omnitrix flags Mistral, the Gemini API and Gemini CLI by default, and you can flag any other account with `omnitrix set <id> --trains-on-data`. A Gemini CLI account added before version 0.1.18 keeps its old setting until you flag it this way. A task marked `secret` runs only on local providers such as Ollama, at an address on this computer, and never on Ollama's cloud models. omnitrix sends prompts only to the providers you connect, and in team mode it also writes usage records, without prompts or results, to the shared `auditDir`. omnitrix itself collects no telemetry, but the agent CLIs it starts follow their own telemetry settings. The training flags are fixed defaults that are not checked against each provider's current terms; OpenRouter, NVIDIA and custom providers are not flagged, so flag them yourself when their terms allow training.

## Connecting accounts

| Account type | Command |
|---|---|
| ChatGPT plan through Codex | `omnitrix add codex --login` |
| Your own Claude subscription | `omnitrix add claude-code --login` |
| An API key | `omnitrix add kimi --key-env MOONSHOT_API_KEY` |
| Gemini | `omnitrix add gemini --key-env GEMINI_API_KEY` with a key from Google AI Studio. A Google AI Pro sign-in works only through `antigravity`, which is experimental. |
| A coding plan (GLM, Kimi, MiniMax) | `omnitrix add claude-code --base-url https://api.z.ai/api/anthropic --key-env ZAI_API_KEY` |
| A local model | `omnitrix add ollama` (LM Studio, llama.cpp and vLLM are also supported) |
| Any other service | `omnitrix add custom-openai --base-url https://host/v1 --key-env MY_KEY --model my-model` |

Run `omnitrix providers` for the full list. Each CLI account has its own profile folder, so two Codex logins never mix. Keys are stored as plain text in `~/.omnitrix/secrets.json`, not in the operating system's keychain; on macOS and Linux only your user account can read the file, and on Windows omnitrix leaves its permissions as Windows sets them. Set `OMNITRIX_HOME` to keep omnitrix's data in another folder. If you use `--key-env`, omnitrix does not store the key at all, and when you give neither `--key` nor `--key-env`, `omnitrix add` uses the provider's usual environment variable if it is set. Avoid `--key <value>`, because the key then appears in your shell history.

To track a limit, specify it when you add the account or later with `omnitrix set`:

```bash
omnitrix set codex-main --r5h 120        # requests per 5 hours
omnitrix set groq-free --rpm 30 --rpd 1000
omnitrix set deepseek --tpd 4000000      # tokens per day
```

The available options are `--rpm` (requests per minute), `--r5h` (requests per 5 hours), `--rpd` (requests per day), `--rpw` (requests per week), `--tpd` (tokens per day) and `--tpm` (tokens per month). Minutes, hours, days and weeks are rolling windows, and the month is the calendar month in local time. Only requests that omnitrix sends are counted, and a request counts once it has finished, so parallel jobs can go somewhat past a limit.

## Team mode

A company that pays for API usage can share its accounts with every developer through one team file, so that each developer's Claude Code can use them without buying extra credits. The file lists the shared API accounts, the price of each model and the budgets. It never contains keys: each account names the environment variable that holds the key on each developer's computer.

```json
{
  "version": 1,
  "name": "Acme",
  "accounts": [
    { "id": "acme-openai", "provider": "openai", "keyEnv": "ACME_OPENAI_KEY", "models": ["gpt-5.2"], "usdPerDay": 40 }
  ],
  "prices": { "gpt-5.2": { "input": 1.25, "output": 10 } },
  "budgets": { "usdPerDay": 5, "usdPerMonth": 60, "people": { "lead@acme.com": { "usdPerDay": 20 } } },
  "auditDir": "//fileserver/omnitrix-audit"
}
```

Prices are in US dollars per million tokens. On Windows, `auditDir` can be a network path such as `//fileserver/omnitrix-audit`; on macOS and Linux, use the folder where the share is mounted, such as `/Volumes/omnitrix-audit` or `/mnt/omnitrix-audit`.

```bash
omnitrix team join ./omnitrix.team.json
omnitrix team join ./omnitrix.team.json --yes <review code>
omnitrix team
omnitrix usage --by person
```

The first command changes nothing. It shows each shared account, the server that its key would be sent to, whether the key's environment variable is set on this computer, any team limit on the account, your budget and the shared folder, together with a short review code. It warns when a server is not the provider's own address, when an account uses a variable that usually holds a personal key, such as `OPENAI_API_KEY`, and when a model has no price. The second command joins the team, and it works only with the review code of the exact contents that were shown, so a file that was edited in between is refused.

You are identified by the email address in your global git configuration, or by your login name if none is set; use `--as <name>` to choose another name. Names in the team file must match exactly, including capital letters, and omnitrix does not verify them. `omnitrix team` shows what you have spent today and this month, and `omnitrix team leave` stops using the file.

omnitrix records the contents of the file when you join. If the file changes later, for example when someone adds an account or changes a server address, its accounts stop loading until you review and join it again. A team file is refused if an account has a field named like a key (such as `apiKey`, `key`, `secret`, `token`, `password` or `authorization`), names a CLI provider such as Codex, Claude Code or Gemini CLI, names a local model server, or has a `baseUrl` that is not a valid `https://` address. It is also refused if an account takes its key from a variable for another kind of credential (for example `AWS_*`, `GITHUB_TOKEN` or a password), sends a variable that usually holds a personal key to a server other than the provider's own, or marks a provider that may train on prompts as safe for private work. omnitrix does not inspect the values of other fields, so a team file should still be checked for pasted keys.

Team accounts are loaded from the file each time and are never saved into your own configuration. For this reason, `omnitrix set`, `enable`, `disable`, `remove`, `model` and `models --refresh` refuse to change them. If you already have an account with the same id, your own account is used, and team budgets never apply to it.

Each request that omnitrix sends to a team account, including `omnitrix test`, is recorded with your name, the team, the account, the model, the tokens, the cost, the time and the job id. When the provider does not report the cost, omnitrix estimates it from the prices in the file; a model without a price counts as costing nothing, so every team model should have one. When your daily or monthly budget is used up, the router skips the team's accounts, and your own accounts and local models still work. A person can have their own budget under `people`. An account can also have a limit for the whole team, `usdPerDay` or `usdPerMonth`. Days and months follow each computer's local time. If budgets cannot be worked out, the team's accounts are skipped rather than used.

When the file names an `auditDir`, the records of your requests on team accounts are also copied to that shared folder, in one file per person. These records hold no prompts or results. omnitrix then counts everyone's spending against the account limits, and `omnitrix usage --team` reports on the whole team. Records that are malformed, that do not belong to the file they are in, or that are dated in the future are ignored, and links, folders and files larger than 10 MB in the shared folder are skipped. Other developers' spending is read from the folder at most once a minute; your own spending counts at once. If the folder cannot be reached, account limits count only your own spending, and `pool_status` says so.

While a request on a team account is running, its largest possible cost, estimated from its prompt and its output limit, counts against your budget and the account's limit in the omnitrix process that sends it, so a burst of requests from one process cannot run far past either. Requests running in other omnitrix processes or on other computers are counted only once their records exist. A request can still cost more than its estimate when its prompt includes large files. Your personal budget counts only the requests made from this computer, and anyone who can write to the shared folder can affect the account limits. Budgets are therefore safeguards rather than strict enforcement; a provider's own spending limit on the company account remains the most reliable protection, and a team should set one as well.

Personal subscriptions cannot be team accounts, because a seat on a plan such as ChatGPT Plus or Claude Pro belongs to one person.

## MCP tools

omnitrix runs as an MCP server and gives Claude the following tools:

| Tool | Purpose |
|---|---|
| `pool_status` | Lists every account with its state, owner, models and remaining quota |
| `route_preview` | Shows which account would receive each task, and why, without running anything |
| `dispatch` | Sends up to 30 tasks at once and runs independent tasks in parallel |
| `get_results` | Waits for up to 50 jobs, 45 seconds by default and at most 110, and returns a short preview of each result, or the full results with `full` |
| `read_output` | Reads a full result in pages of 12,000 characters by default and at most 40,000 |
| `rate_result` | Accepts or rejects a result so that the router can learn from it, and can send a rejected task to another model |
| `cancel_job`, `list_jobs` | Cancels a job, its pending check or its running test, or lists the 20 most recent jobs (at most 100) |

Each task has a `title` of at most 200 characters, a `type`, a `prompt` and optionally an `acceptance` line, a `privacy` level, `files`, a `repo`, a `size` (`small`, `medium` or `large`), `use` to force an account or model, `effort`, `check` and, for code tasks, `test`. `route_preview` accepts up to 30 tasks.

The `pool_status`, `dispatch` and `get_results` tools declare output schemas, and their structured data contains everything their text shows. `list_jobs` also lists jobs that other omnitrix processes started, and `cancel_job` can cancel them.

A task can set `effort` to `low`, `medium` or `high` to ask a reasoning model to think less or more. omnitrix passes it to Codex and to OpenAI-compatible APIs such as Gemini, but not to Anthropic-format APIs or to other agent CLIs; without it, each provider uses its own default. From the command line, use `omnitrix run --effort high`. Some models write their reasoning before the answer, such as Gemma 4 inside `<thought>` tags or DeepSeek R1 inside `<think>` tags; omnitrix removes such a block from the start of an answer from an OpenAI-compatible API, so that Claude receives only the answer.

### Checking and retrying results

A task can set `check` to `true` together with an `acceptance` line. When the result is ready, omnitrix sends a short review task to a different account. That task contains the instructions, the acceptance line and the result, with secrets removed and the result marked as data rather than instructions, and asks for PASS or FAIL with a one-sentence reason. Checks run only on models without tools, never on an agent CLI that can read files or run commands. `get_results` waits for this verdict and shows it next to the result, and the dashboard shows it on the row of the job that was checked. The check follows the privacy level of the task, so private work is checked only by an account that may receive private work. The checking model must also be about as good at review as the model that did the work: its estimated review fit may be at most 0.15 lower, so that a small model does not pass work it cannot judge. If no other suitable account is available, the check is reported as unavailable, with the reasons. The check uses the checking account's quota, and it reads the worker's report, not the changed files. It reads at most the first 4,000 characters of the instructions and 20,000 characters of the result. It is advice for Claude's own review and does not replace it.

When Claude rejects a result, it can call `rate_result` with `retry` set to `true` and a note that explains what was wrong. omnitrix then sends the same task to a model that has not been rejected for it, with the note added to the instructions. The new worker sees the note but not the rejected answer. A job is retried only once; to try again, rate the new job. A check job cannot be retried. A retry does not keep a forced `use`, and a task with `check` is checked again. The note can be up to 500 characters.

By default, previews are limited to 1,500 characters to keep Claude's token usage low; `omnitrix settings --preview-chars` changes the limit. Full outputs remain on disk.

## Commands

```
omnitrix init                   list what can be connected on this computer (--apply connects it, --no-open skips the dashboard)
omnitrix providers              list the providers you can connect
omnitrix add <provider>         connect an account (--label, --owner, --id, --key-env, --base-url, --model, --concurrency, limits)
omnitrix login <id>             sign in a CLI account in its own profile
omnitrix list                   show accounts, usage and remaining quota (also "status"; --json for machine-readable output)
omnitrix test <id>              send a small request to check an account (--model picks one)
omnitrix set <id>               change limits, label, owner, key, base URL, priority, concurrency or --trains-on-data
omnitrix enable|disable <id>    enable or disable an account
omnitrix remove <id>            remove an account (--purge also deletes its login)
omnitrix models <id>            show model scores and rated jobs (--refresh queries the provider again)
omnitrix model <id> <model>     set scores or prices, or --add or --remove a model
omnitrix route <prompt>         show which model would receive a task (--type, --privacy)
omnitrix run <prompt>           run one task and print the answer (--type, --privacy, --use, --repo, --effort)
omnitrix settings               set the mode, private protection, pins, bans, the job time limit and the preview length
omnitrix dashboard              open the live dashboard on 127.0.0.1:4590, which runs in the background (--stop, --port, --no-open, --serve)
omnitrix setup-claude           register with Claude Code (--scope user|project|local, --no-statusline, --dry-run)
omnitrix team                   join, review or leave a team file, and show your spending (join --as, --yes; leave; status)
omnitrix usage                  requests, tokens and cost for the last 30 days (--by person|account|model, --days, --team)
omnitrix clean                  delete finished jobs and worktrees older than 14 days (--days, --dry-run, --branches)
omnitrix doctor                 check the setup
omnitrix mcp                    run the MCP server (Claude Code starts this itself)
omnitrix statusline             print the status line (Claude Code runs this itself)
```

Run `omnitrix <command> --help` for every option of a command. `omnitrix run` takes no `check`, `test`, `files` or `size`; those are set by Claude through `dispatch`.

`omnitrix clean --branches` also deletes the git branch of each old job that was rejected, failed or cancelled, and the branch of any other old job once its work is already in the repository's current branch. A branch with work that has not been merged is kept, together with its job record, so that a later `clean --branches` can still remove it once it is merged or rejected. Work taken by copying files from the branch, rather than by merging it, does not count as merged, so the command names each branch it keeps; delete one with `git branch -D <name>` once you no longer need it. Only branches that omnitrix created for its jobs are deleted. Add `--dry-run` to see what would be deleted first; it changes nothing.

`omnitrix settings --mode saver` prefers free and low-cost models, `--mode quality` prefers the strongest models, and `--pin code=codex-main` tries that account first for code tasks whenever it is eligible.

## Provider terms

omnitrix uses only official CLIs and APIs with credentials that you enter yourself. It provides no means of importing another person's login.

OpenAI, Google and Anthropic all prohibit sharing a consumer account, so connect only accounts that you own. A friend who wishes to contribute should use an API key billed to them. Anthropic permits Claude subscriptions for ordinary individual use only. Google has suspended accounts that used Antigravity sign-in through third-party tools, so omnitrix marks Antigravity as experimental and recommends Gemini API keys instead. Free tiers are often limited per organization, so additional keys from the same organization provide no extra quota.

omnitrix is an independent project. It is not affiliated with OpenAI, Google, Anthropic or any other AI provider, or with Cartoon Network and Warner Bros. Discovery. Product names and trademarks belong to their respective owners.

## Agent CLI compatibility

omnitrix starts each agent CLI with flags taken from that tool's own documentation. This table shows how each one was last checked, in November 2026.

| CLI | How it was checked | Not yet confirmed |
|---|---|---|
| Codex | Every flag confirmed with the `--help` of codex-cli 0.167.1 on Windows, and used in real jobs and quota readings | |
| Claude Code | Every flag confirmed with the `--help` of Claude Code 2.1.325; `--permission-prompts` needs 2.1.259 or later | the exact names of the token counts in its JSON output |
| Gemini CLI | Flags confirmed in the official documentation | Google now offers it mainly with Code Assist licences |
| Qwen Code | Flags and its list-of-messages answer confirmed in the official documentation | |
| OpenCode | `opencode run --model` confirmed in the official documentation | reading the task from standard input, and an answer printed as plain text |
| Antigravity CLI | Experimental, and not added by `omnitrix init`; `--mode accept-edits` for code tasks and `--model` follow the official documentation | reading the task from standard input |

The tests check every driver's flags and how it reads the documented answer format, and they run the Codex driver against a fake CLI. Only Codex has also been run in real jobs, so treat the others as less tested, and report a CLI that fails with the output of `omnitrix test <id>`.

## Current limitations

Remaining quota is measured for ChatGPT plans and for providers that send rate-limit headers. For other subscriptions it is an estimate, because those providers do not offer an API for it. The agent CLI drivers depend on the current flags of those tools and may need updating when the flags change.

## Roadmap

The next planned feature is friend nodes. A friend would run a small agent on their own computer with their own login and a daily cap that they can pause at any time, so their account never leaves their machine. Later plans include drivers for Aider and Goose.

## Development

```bash
git clone https://github.com/MdHashim1011/omnitrix.git
cd omnitrix
npm install
npm run build
npm test
```

The tests use fake providers and fake agent CLIs on this computer, so they require neither API keys nor internet access.

## License

Apache-2.0. Copyright 2026 Mohamed Hashim.
