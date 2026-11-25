<img src="assets/omnitrix-icon.svg" width="96" alt="The omnitrix icon: three coloured arcs, one for each AI connection, around a white core">

# omnitrix

[![MdHashim1011/omnitrix MCP server](https://glama.ai/mcp/servers/MdHashim1011/omnitrix/badges/score.svg)](https://glama.ai/mcp/servers/MdHashim1011/omnitrix)

Claude plans the work, and your other AI accounts carry it out.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/job-v3-dark.svg">
  <img alt="An example job, 'add rate limiting to the public API', split by Claude into six tasks in two rounds. First, Gemini reads the exported issues, Codex writes the middleware on its own git branch, Groq drafts the changelog and a local Ollama model checks the .env file for leaked keys. Then DeepSeek reviews the middleware diff, and the edge-case task moves to GLM because Kimi is rate limited. Claude checks each result and merges the accepted branch." src="assets/job-v3-light.svg" width="100%">
</picture>

I built omnitrix because I repeatedly ran out of Claude credits while my ChatGPT Plus plan and my Gemini key remained largely unused.

omnitrix is built for the frontier-model subscriptions and API keys you already pay for, and it runs inside your existing Claude Code session. Claude remains in charge: it divides the job into tasks and reviews the results. omnitrix sends each task to an account that suits the work and still has quota available. For example, it can use Codex on your ChatGPT plan for code edits, Gemini for reading very large logs, DeepSeek or Kimi for reasoning and review, or a local model for private work. It also supports any service that implements the OpenAI Chat Completions format or the Anthropic Messages format, through `custom-openai` and `custom-anthropic`.

You can monitor the pool without leaving Claude Code. The status line shows up to four accounts with their remaining quota or status, and omnitrix instructs Claude to check the same data before it assigns work. Claude reads short results instead of performing every step itself, which uses less of your Claude usage limit.

## A real run

The recording below replays one real run in Claude Code, with the waiting shown six times faster. Claude splits a request into three tasks. Codex writes the code on its own git branch, and omnitrix runs the project's tests on it. Gemini reviews a file and then checks the work Codex did. A local Ollama model drafts the changelog. Claude reviews each result before it merges the branch. The three workers used 137,597 tokens on their own accounts, while Claude read fewer than 3,000 characters of their results.

<img src="assets/demo.gif" width="100%" alt="A recorded run in Claude Code. The request is to add two coupon codes to a small shop project, review cart.js for bugs and draft a changelog entry. Claude sends three tasks to omnitrix: Codex on a ChatGPT Plus plan writes the coupon code in 56 seconds, Gemini reviews the cart in 9 seconds and a local Ollama model drafts the changelog in 10 seconds. Gemini then checks the code and reports PASS. The results show that the tests passed and that Gemini found a real bug on line 11, where removing a missing item deletes the last one. Claude accepts all three results, merges the branch, and the four tests pass.">

One run proves little, so `omnitrix report` adds up every job on your own accounts: per model and task type, how many jobs finished or failed, how many Claude accepted or rejected, the median time and the tokens used. It also splits the tokens by outcome: how many went to work that Claude accepted, how many to work it rejected or to failed jobs, and how many to work not rated yet, so wasted work shows up as a number. Failed jobs that were pinned to one account or model with `use` are counted apart, because omnitrix may not move those elsewhere. In my own use over the 30 days to 23 November 2026, Codex on a ChatGPT Plus plan finished 10 code jobs, and Claude accepted all 8 of those it rated, with a median time of 1.2 minutes per job. Gemini's free models usually answered reviews and drafts within seconds, but Claude accepted only 6 of the 13 Gemini reviews it rated. These are small samples from one person, and the report adds a note when any rate rests on fewer than five rated jobs. It reads the job records kept on your computer, and `omnitrix clean` deletes records older than 14 days by default, so a longer report covers only the jobs since the last clean.

The other side of the question is how much of Claude's own limit goes into running omnitrix, and `omnitrix overhead` measures it from the session files that Claude Code keeps on your computer. It counts Claude's calls to omnitrix's tools, the output tokens of the replies that made them (thinking included) and the size of the results Claude read back, and shows them next to the workers' accepted tokens. In my own use over the 30 days to 24 November 2026, Claude made 127 omnitrix tool calls in 9 sessions, wrote 58,000 output tokens in those replies and read about 22,000 tokens of results, while the workers used 2.7 million tokens on work that Claude accepted. The two are not the same cost, since one comes out of the Claude limit and the other out of other accounts, so the command does not convert one into the other. It also leaves out planning that Claude did before it called omnitrix, and results it reads again on later turns, which are usually cached. The dashboard shows the same figures for the last 7 days under "Done by other accounts", read again at most every 10 minutes while it runs. The command and the dashboard keep only the totals; Claude Code's file format is not documented, so a file it cannot read is reported rather than guessed.

## Who it is for

omnitrix suits you if you work in Claude Code, have other AI accounts that sit idle (a ChatGPT plan, free or paid API keys, local models), and want Claude to hand work to them and check the results instead of switching between tools yourself. It is a weaker fit if you prefer to drive several agents by hand in one window, which an app such as [T3 Code](https://github.com/pingdotgg/t3code) does well (omnitrix also works inside it, see [Inside T3 Code](#inside-t3-code)), or if you need one OpenAI-compatible endpoint for other applications, which a gateway such as FreeLLMAPI or OpenRouter provides.

### Why not Claude Code's own subagents?

Claude Code can already split work across subagents, including cheaper ones such as Haiku. Every subagent is still Claude, however, so all of that work comes out of the same Claude usage limit. omnitrix sends the work to accounts outside that limit: a ChatGPT plan through Codex, API keys from other providers and models on your own computer. It also does the bookkeeping that subagents leave to you. It reads the remaining quota where the provider reports it (a ChatGPT plan through Codex, or rate-limit headers), counts requests and tokens against the limits you set for the others, and routes around accounts that are out of quota or forecast to run out. It runs your tests on code changes itself when the task names a test command, can have a second model check a result, and learns from the results Claude accepts or rejects. Subagents remain the better choice for work that needs Claude itself.

## How omnitrix compares

Several projects connect Claude Code or other tools to many models. They solve different problems, so the right choice depends on what you need. This comparison is based on each project's own documentation as of November 2026.

| | omnitrix | [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) | [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server) | [OpenRouter](https://openrouter.ai) |
|---|---|---|---|---|
| What it is | MCP server: Claude plans, other models do typed tasks, Claude reviews | Self-hosted gateway: one OpenAI- and Anthropic-compatible endpoint over many free tiers | MCP server: Claude calls other models through tools such as chat, consensus and code review | Hosted gateway: one paid API for many models |
| Claude stays the lead | Yes | No: Claude Code itself can run on the free models | Yes | Not applicable |
| ChatGPT plan through Codex, API keys and local models in one pool | Yes | API keys and local models | Yes, the CLIs through its clink tool | API models only |
| Remaining quota measured, with forecasts and reset-aware routing | Yes | Usage counted per key against free-tier limits | No | Credits on your OpenRouter account |
| Code edits in their own git worktree, with omnitrix's own test run | Yes | No | No | No |
| Several independent answers, a second-model check, retries with the reason | Yes | Combines several models into one answer | Consensus across models | Fallback to another model on errors |
| Learns from the results that Claude accepts or rejects | Yes | No | No | No |
| Privacy levels per task, including work that may only go to local models | Yes | No | No | Provider filters by data policy |
| Installation | One npm command, also on Windows | Install script with Docker, or a desktop app | Python and uv, with a WSL setup guide for Windows | Nothing to install |
| Where prompts go | From your computer straight to each provider | Through your own gateway to the providers | From your computer to each provider | Through OpenRouter |

omnitrix is not a gateway. If you need one OpenAI-compatible endpoint for other applications, FreeLLMAPI or OpenRouter fits that job better. omnitrix is for keeping Claude in charge of your work while your other accounts do the parts they handle well, with every result checked before you rely on it.

## Installation

omnitrix requires Node.js 20 or later.

```bash
npm install -g omnitrix
```

omnitrix is also a Claude Code plugin. In Claude Code 2.1.275 or later, this command installs it in one step:

```
/plugin install omnitrix --marketplace MdHashim1011/omnitrix
```

From a terminal, `claude plugin marketplace add MdHashim1011/omnitrix` followed by `claude plugin install omnitrix@omnitrix` does the same. The plugin starts the latest omnitrix from npm with `npx`, so it needs Node.js 20 or later as well. It registers the MCP server only: add your accounts with `npx omnitrix init --apply`, or install the package globally with the command above to have the `omnitrix` command itself.

The plugin also adds four commands that you can type in Claude Code:

| Command | What Claude does |
|---|---|
| `/omnitrix:delegate <work>` | Splits the work into tasks, sends them to your other accounts, checks every result and merges what it accepts |
| `/omnitrix:review [files or range]` | Has three different models review the code independently, checks each finding against the code and reports the ones that hold up, noting which reviewers found them |
| `/omnitrix:second-opinion [question]` | Asks another model to find what is wrong with an answer or plan, by default Claude's last one, and reports where it agrees and disagrees |
| `/omnitrix:pool` | Shows each account's state, remaining quota and reset times |

Without the plugin, you can ask Claude for the same things in your own words.

### Inside T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) runs Claude Code with its normal configuration, so once omnitrix is registered with Claude Code, Claude threads in T3 Code can use it with no extra setup. This was checked in November 2026 with T3 Code 0.1.11 and Claude Code 2.1.328 on Windows: a Claude thread in T3 Code found all eight omnitrix tools, read the pool, sent a task that omnitrix routed to a free Gemini key, and collected and rated the result. A code task was checked on 23 November 2026 with Claude Code 2.1.330: the Claude thread sent omnitrix a change to a CSV parser with a test command, Codex wrote it on its own branch, omnitrix reported that only the two named files had changed and that all 20 tests passed, and Claude read the change and accepted it. Codex as the lead in T3 Code has not been tested yet.

The same package is attached to each GitHub release, so you can also install it from there:

```bash
npm install -g https://github.com/MdHashim1011/omnitrix/releases/latest/download/omnitrix.tgz
```

Each release from version 0.1.21 onward also includes `omnitrix.tgz.sha256`, the SHA-256 checksum of the package. To check a download before installing it, download both files from the release page and compare the checksum with the one that your computer calculates:

```bash
certutil -hashfile omnitrix.tgz SHA256
shasum -a 256 omnitrix.tgz
```

The first command is for Windows and the second for macOS and Linux. The value it prints must match the one in `omnitrix.tgz.sha256`. Then install the file you checked with `npm install -g ./omnitrix.tgz`.

### In other MCP apps

omnitrix is an ordinary MCP server, so other apps that run local MCP servers can use it as well. `omnitrix mcp-config` prints the entry to add, with the full paths of Node.js and omnitrix on your computer, so the app needs neither your PATH nor the npm command shim. On a Mac with Node.js from nodejs.org, it looks like this:

```json
{
  "mcpServers": {
    "omnitrix": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/usr/local/lib/node_modules/omnitrix/dist/cli.js", "mcp"]
    }
  }
}
```

Cursor reads this entry from `~/.cursor/mcp.json`, or from `.cursor/mcp.json` inside a project. The GitHub Copilot agent in VS Code reads the same shape from `~/.copilot/mcp-config.json`, while the older `.vscode/mcp.json` file uses the key `servers` instead of `mcpServers`. Other apps keep the file elsewhere, so check their MCP documentation. Cursor and VS Code have not been tested yet.

[OpenCode](https://opencode.ai) uses a different shape: add omnitrix under `mcp` in `opencode.json`, in the project or in `~/.config/opencode/`, with the command and its arguments in one list:

```json
{
  "mcp": {
    "omnitrix": {
      "type": "local",
      "command": ["/usr/local/bin/node", "/usr/local/lib/node_modules/omnitrix/dist/cli.js", "mcp"],
      "enabled": true
    }
  }
}
```

This was checked on 24 November 2026 with OpenCode 1.19.6 on Windows: `opencode mcp list` showed omnitrix as connected, and with OpenCode's free DeepSeek V4.1 Flash model as the lead, `opencode run` read the pool, dispatched a task that omnitrix routed to a local Ollama model, collected the answer and rated it, and the rating was saved in omnitrix's job record. The lead model has to handle tool calls well; a 3B local model as the lead printed its tool calls as text instead of making them. In another app, its own model takes Claude's place as the lead, and the figures for Claude's own limit are not available, because they come from the Claude Code status line.

## Quick start

```bash
omnitrix init
omnitrix init --apply
omnitrix setup-claude
```

`omnitrix init` lists the agent CLIs that omnitrix supports and finds on your PATH, the API keys set in the environment variables that `omnitrix providers` names (for example `DEEPSEEK_API_KEY`), and the local model servers that answer at their default addresses. It also shows which of them are already connected. Without `--apply`, it does not create or change anything. With `--apply`, it connects each new one in the same way as `omnitrix add <provider>` with no other options. It shows only the names of environment variables, never their values. For API keys, it stores a reference to the environment variable rather than the key itself, so the variable must also be set where Claude Code starts omnitrix. With `--apply`, when it finishes, it opens the dashboard in your default browser, even if nothing is connected yet; use `--no-open` to skip this. Without `--apply` it starts nothing, and only mentions `omnitrix dashboard`. It does not open a second tab when one is already open, and it does not start the dashboard when `CI` or `OMNITRIX_NO_BROWSER=1` is set.

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

Each remaining model receives a score based on how well it fits the task, how much quota the account has left, what the model costs, and how often its past work was accepted. An account without a known limit, such as a local model or an API key with no limits set, is counted as having 80% left, so that it ranks just below a fresh account whose quota is known; `omnitrix route` shows this as "no known limit". An account that is already running as many jobs as its concurrency limit allows has its score halved. The highest-scoring model receives the task. If that call fails, omnitrix ranks the accounts again, skips those it has already tried, and passes the task on without any action from Claude. After a timeout or a server error, the same account stays eligible with another of its models, but within that job the model that failed is never tried again, and after a local model times out, the job also skips that computer's models that are as big or bigger. A job makes at most three attempts, and at most twelve tries in total when retired models are included. A request that the provider rejects as invalid, including an `effort` value that the model does not accept, fails the job without another attempt, and so does an answer that arrived but could not be saved. A model that the provider no longer serves, or for which the plan has no allowance, is removed from the account and rests for 24 hours, and trying it does not count as an attempt.

Three further adjustments multiply that score. Each adjustment that applies is listed in the reasons shown by `omnitrix route`, which lists the top eight candidates, and by `route_preview`, which lists the top three:

- If a window that the provider reports with a reset time resets within the next hour, and the account still has at least 20% left in its tightest window, the score is multiplied by 1.25 so that the quota is used before it is lost. Windows that omnitrix counts itself have no reset time, so this applies only to providers that report their own windows, such as ChatGPT through Codex.
- If an account is forecast to run out of a window before it resets, as described under "Monitoring quota", the score is multiplied by 0.75 so that the account keeps some quota in reserve. This takes precedence over the previous adjustment.
- For a public task, a model with no price set, on an account that may train on prompts, has its score multiplied by 1.15. Such an account can only take public work, so giving it that work first leaves the other accounts' quota for private tasks. This does not apply in quality mode.

Together these adjustments can raise a score by about 44% or lower it by 25%, so they can change the order of models whose fit for the task is similar. A pin adds a large fixed amount, so in practice pinned accounts rank above all others, but the adjustments can change the order among pinned accounts.

omnitrix also notes how long each answer took. A model's typical answer time is the median of its last 20 successful answers in the last 30 days, once it has at least 3, and `omnitrix models <id>` shows it in the "typical" column. A task that sets `fast` to `true`, or `omnitrix run --fast` and `omnitrix route --fast`, prefers quick models: the model with the quickest typical time keeps its score, and one ten times slower loses about half of it. A model without a typical time yet is judged by its speed score, a little below the quickest measured model, so that a guess does not beat a measurement. Without `fast`, answer times do not affect routing.

A task can also name a route, which changes how that one task is routed without changing your settings. There are four built-in routes: `fast` ranks as a fast task does, `deep` ranks as quality mode does, `cheap` ranks as saver mode does, and `local` uses only models on this computer. `omnitrix routes add review --description "second opinions" --use deepseek,home/qwen3 --mode quality` adds a route of your own that uses only the accounts and models it names; a route of your own with the name of a built-in route replaces it. `pool_status` lists every route with its description, so Claude can choose one by what it is for. A route never loosens privacy: a private task still skips providers that train on prompts, and an unknown route name is refused instead of being ignored. `omnitrix run --route` and `omnitrix route --route` use a route from the command line.

A task with `escalate` set to `true` tries the cheap route first. When its second-model check returns FAIL, its answer does not match its `output_schema`, or the test of a code task fails, omnitrix runs the task once more on the deep route, avoids the model that failed, and tells the new worker why the first attempt failed without showing it the failed answer. A check that is unclear or could not run, and a test that could not start, do not count as a failure. The task needs `check` with an acceptance line, an `output_schema`, or `test` for a code task, and cannot be combined with `use`, `route`, `copies` or `follow_up_of`. `get_results` for the first job waits for the second and returns both, with `escalated_to` on the first and `escalated_from` on the second. omnitrix does not record a verdict on the failed attempt by itself, because a check is advice; Claude rates both jobs.

A task other than a code task can give an `output_schema`, a JSON Schema for the answer, when Claude needs data rather than prose, such as a list of findings with line numbers. The worker is asked to answer with only that JSON, at the end of its prompt. omnitrix then reads the answer, also when the model wraps the JSON in a code fence or a sentence, and checks it against the schema; `get_results` shows under `structured` whether it matched, up to 10 problems when it did not, and the parsed value when it fits in a preview (with `full` it is always included). A schema that omnitrix cannot use, such as one with an unknown type, a $ref to another file, conditional keywords (`if`, `then`, `else`) or more than 20,000 characters, is refused before the task runs.

On a computer with an NVIDIA graphics card, omnitrix reads the card's memory once with `nvidia-smi` and reads the size of each Ollama model every time it checks the local server. A local model larger than the card's memory runs mostly on the processor, which is many times slower, so its score is multiplied by 0.4 and the reasons say so, for example "about 19 GB, more than this computer's 4 GB of GPU memory". Other graphics cards and Apple's shared memory are not read, so nothing changes for them.

A local server can cut a long prompt without an error. Ollama gives each model a working size, 4,096 tokens on the computer where this was checked, whatever the model itself supports, and keeps only part of a longer prompt; the model then answers what is left. In that check, a prompt of about 6,000 tokens reached `llama3.2:3b` as 2,050 tokens, and the model could not answer a question about the start. omnitrix compares the number of prompt tokens that the server reports with the length it sent, about four characters per token. When a prompt of more than about 3,000 tokens arrived less than half complete, the answer is not used and the task goes to another model. omnitrix also remembers, for 7 days, how much that model reads: for Ollama the working size it reports for the loaded model, otherwise the number of tokens that arrived. During that time, longer tasks skip the model and shorter ones still go to it. When no model can read the whole prompt, the job fails and says so, rather than returning an answer to part of the task. To give Ollama's models more room, start Ollama with the `OLLAMA_CONTEXT_LENGTH` environment variable set higher, such as 32768. A larger size needs more memory and makes long prompts slower.

Code tasks go to agent CLIs that can edit files, and to API accounts when [OpenCode](https://opencode.ai) is installed (`npm install -g opencode-ai`). For a code task on an API account, omnitrix runs OpenCode as the agent and gives it a configuration that names only that account's endpoint and the chosen model, so no other provider receives the task, and titles and summaries go to the same model. The key reaches OpenCode in an environment variable of its own and is not written into the configuration, and OpenCode runs with a home folder of its own inside omnitrix's data folder, so your own OpenCode settings, keys and MCP servers are not loaded. This way any OpenAI-compatible key, such as DeepSeek, GLM, Kimi, Qwen, Groq, OpenRouter or a local Ollama server, can do code tasks; a Gemini key goes through Google's own adapter, because Gemini 3 needs it for tool calls. The model has to make tool calls: omnitrix skips a local model whose server reports that it cannot, and small local models often fail at it even when their server says they can make them. This was checked on 24 November 2026 with OpenCode 1.19.6 on Windows, where a free Gemini key created a file in a job's branch. `omnitrix settings --api-code-agent off` keeps code tasks away from API accounts. Each task runs on a new branch in its own git worktree, so two workers never share a checkout. Other tasks that name a repository and go to an agent CLI run in a temporary copy of the repository that is removed afterwards, so a reviewing worker does not work in your checkout. The copy is taken at the last commit, and the files that the task lists are copied into the prompt from your working tree, including changes that are not committed.

After a code task, omnitrix checks the branch itself rather than relying on the worker's report. It lists the files that the worker changed and, when the task named its files, the changed files that the task did not name. When the task gives a `test` command, such as `["npm", "test"]`, omnitrix runs it in the job's worktree after the worker finishes and reports whether it passed, its exit code and the end of its output, without terminal colour codes. The worktree is a fresh copy without installed packages, so for a Node.js project use `["npm", "install-test"]`, which installs them before it runs the tests. `get_results` waits for the test, and the dashboard shows the result on each job as "Checked by omnitrix". The test runs the worker's code on your computer, without keys in its environment, with an empty home folder of its own and with its own time limit, equal to the job limit but at most one hour; `cancel_job` stops it when it runs in the same omnitrix process. When two finished jobs in the same repository changed the same file and neither started from the other's result, `get_results` lists the other job under `also_changed` for each of them, because copying one job's files over the other's would silently lose work; the two changes have to be combined, for example with a merge. Rejected jobs and jobs whose branch was deleted are left out, only the 50 most recent jobs are compared, and a file that both jobs left with the same content is not listed.

A job's branch starts from the commit that was current when the job began. When the repository has moved on since then, `get_results` says so under `behind`: how many newer commits there are, and which of the job's own files those commits changed. If any did, the code Claude would review and test is not the code that a merge would produce, so `omnitrix rebase <job>` replays the job's commit onto the current `HEAD` in a separate checkout, moves the branch only when that succeeds, and then lists the changed files and runs the job's test again on the result. A check by another model is dropped, because it looked at the code before the rebase. On a conflict it changes nothing, lists the conflicting files and exits with code 1, so the job can be merged by hand or tried again from the current `HEAD`. It also exits with code 1, without changing anything, when the job cannot be rebased, for example because its branch is gone or already merged. The command never runs git inside the worker's own checkout, because the worker could have changed that checkout's `.git` file. The dashboard shows the same warning on the job, with the command to run, and looks again at most every 30 seconds; rejected jobs are left out, since nobody will merge them.

omnitrix also records the commit that it checked and tested. If the job's branch later gets a commit that omnitrix did not check, or a tracked file in the job's checkout is changed and not committed, `get_results` says so under `changed_since_check`, because the files and the test result may then not describe the code that a merge would take: a merge takes only the branch's commits, while the test ran in the checkout. New files that nobody added to git, such as a test's build output, are not counted. The dashboard shows the same warning on the job. Jobs that finished before version 0.8.6 have no recorded commit and show no such warning.

Lockfiles such as `package-lock.json`, `Cargo.lock` or `go.sum` get their own check, because two jobs that each add a package both change the lockfile, and combining lockfiles by hand rarely works. For every lockfile a job changed, `get_results` lists under `lockfiles` the packages the job added, changed (an existing version replaced by another) and removed, and says whether it only added. omnitrix reads `package-lock.json`, `npm-shrinkwrap.json`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `go.sum`, `composer.lock` and `Pipfile.lock`; other lockfiles, such as `yarn.lock` or `pnpm-lock.yaml`, are flagged for review by hand. When two jobs changed the same lockfile, omnitrix asks Claude not to combine it, but to merge the other files, run the package manager once to regenerate the lockfile, and then run `omnitrix lockcheck`. That command compares each changed lockfile with `HEAD`, or with the revision given by `--base`, prints what was added, changed or removed, and exits with code 1 when an existing package changed or was removed, or when a lockfile could not be checked. A regenerated lockfile should normally only add packages, so any change it lists deserves a look before you commit.

omnitrix never merges anything: Claude still reviews the work, and you decide what to keep.

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

When Claude sends its first task in a session, omnitrix opens the dashboard in your browser, unless a page already shows it. It does this once per session. Turn it off with `omnitrix settings --open-dashboard off`; it is also skipped when `OMNITRIX_NO_BROWSER=1` or `CI` is set. Some embedded browsers, such as the browser pane of the Claude desktop app, do not deliver live updates; when no update arrives within four seconds, the page asks for new figures every few seconds instead.

Each job in the list shows the tokens of all its attempts, including failed ones, plus the second-model check when there was one, so a job that was retried shows what it really cost. The account card shows "Last 24 h, all requests", which also counts checks, `omnitrix test` and jobs no longer in the list, so its total is usually larger than the sum of the jobs shown. A finished, failed or cancelled job has a Remove button, and "Remove failed jobs" removes every failed job at once. Removing a job only hides it from the dashboard: its record stays, so Claude can still read its result, and `omnitrix clean` deletes it later. The page accepts these requests only with a token that changes each time the dashboard starts, so other web pages cannot remove jobs.

To show what omnitrix does for you, the dashboard, `pool_status` and `omnitrix usage` also report the work that other accounts did instead of Claude: in the last 7 days, or the days given to `omnitrix usage --days`, how many jobs another account answered, how many of them Claude accepted or rejected, and how many tokens those answers took, for example "other accounts answered 29 jobs (13 accepted, 9 rejected by Claude) and processed 1.5M tokens that Claude did not have to". The figures are counted from the usage log, not estimated. No price is put on them, because a Claude subscription is not billed per token.

The dashboard shows each account's name, owner, usage in the last 24 hours and the quota remaining in each tracked window. When the provider's own numbers cannot be read again, it keeps the last ones, shows when they were read, and marks them as possibly out of date. In Claude Code, the status line gives a compact summary of up to four accounts. The Claude figures at the end appear when Claude Code provides them, which it does on Pro and Max plans:

```
omnitrix 5/6 ready · codex-main 38% · deepseek 788 left · kimi wait · groq-free 36% +2 │ Claude 5h 34% 7d 12%
```

Account percentages show the share remaining, and the Claude figures show the share used.

The status line also saves the Claude figures, so `pool_status` can show Claude how much of its own limit is used and when each window resets. The dashboard shows them on a card of their own, next to the other accounts. When 70% or more of a window is used, `pool_status` asks Claude to delegate more and read less itself. The figures come only from the status line, so they appear once a Claude Code session with the omnitrix status line has run, and `pool_status` marks them as old after 15 minutes without an update.

Most subscriptions neither publish exact limits nor provide a way to query the remaining allowance, so omnitrix states the source of each figure. For a ChatGPT plan, it queries Codex directly and shows the percentage remaining in each window that Codex reports, usually 5 hours and 7 days, along with the time each window resets. This query ignores any API key exported in your environment, so the figures always belong to the account's own plan. When a provider sends rate-limit headers, omnitrix reports the remaining requests in the status line and in `pool_status`. In all other cases, it counts the requests and tokens it has sent against the limits you configured. A `402` response, or a `429` response that mentions quota or billing, marks the account as out of quota until the provider's reset time, or for one hour when the provider gives no time. Any other `429` pauses the account until the time in `Retry-After`, or for 60 seconds, and a `429` that reports `limit: 0` pauses only that model, for 24 hours. These waits never exceed 24 hours, whatever the count shows.

Codex reports its windows in whole percent, so a window can read 100% left after a few small jobs. The dashboard then shows "under 1% used". Each Codex request also carries Codex's own instructions and tool descriptions, even for a one-line answer; omnitrix adds about 70 tokens of its own. Many of those tools serve features that a worker never uses, such as browser and computer use, apps, plugins, image generation and sub-agents, so omnitrix turns those features off for its tasks. Measured with codex-cli 0.167.1, this took a one-word answer from about 25,000 input tokens to about 13,800 on the default model, and from about 21,400 to about 16,400 on `gpt-6.2-astra`. The shell, file edits and picture viewing stay on, so code tasks work as before. omnitrix turns off only features that the installed Codex lists in `codex features list`, so a renamed feature is skipped rather than breaking the request. `omnitrix settings --codex-tools all` keeps every tool. Group small questions into one task when you can.

A ChatGPT account added before Codex had run once lists only the model `default`, which leaves the choice to Codex: at the time of writing, its newest model at low reasoning effort. Once Codex has saved its model list in the account's profile folder, omnitrix replaces `default` with the listed models the next time it starts, or when you run `omnitrix models <id> --refresh`, so the router can choose between them. A model list you set yourself, or a pinned `default`, is left alone.

On a ChatGPT (Codex) account, omnitrix also chooses how hard the model thinks, from the kind of task: low for bulk, writing, code snippets and pictures, medium for code changes and long documents, and high for reviews and reasoning. A stronger attempt that follows a failed check always runs at high. Claude can set a different level for a task that is easier or harder than its kind suggests, and its choice comes first. To fix one level for an account instead, run `omnitrix set <id> --effort low`, `medium` or `high`; `--effort auto` returns to the automatic choice. `omnitrix settings --auto-effort off` leaves the choice to Codex, which uses low. Other providers receive a level only when Claude or you set one, because some of their models refuse it. The dashboard shows the effort each job ran at, marked "(auto)" when omnitrix chose it.

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
| A free tier | `omnitrix add groq`, `sambanova`, `cerebras`, `huggingface`, `cohere` and others, each with the key in its usual environment variable |
| GitHub Models | `omnitrix add github-models` with a GitHub token that has the `models:read` permission in `GITHUB_TOKEN`; name models as `publisher/model`, such as `openai/gpt-4.1` |
| Cloudflare Workers AI | `omnitrix add cloudflare --base-url https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` with the token in `CLOUDFLARE_API_TOKEN` |
| A local model | `omnitrix add ollama` (LM Studio, llama.cpp and vLLM are also supported) |
| Any other service | `omnitrix add custom-openai --base-url https://host/v1 --key-env MY_KEY --model my-model` |
| One more model on an account | `omnitrix model <account> <model> --add`, or `omnitrix models <account> --refresh` to read the provider's current list |

Run `omnitrix providers` for the full list, and `omnitrix providers --free` for only the providers with a free tier, free credits or a free allowance, plus local servers. `omnitrix init` finds keys in the usual environment variables, but it does not add GitHub Models or Cloudflare on its own, because `GITHUB_TOKEN` and `CLOUDFLARE_API_TOKEN` are often set for other tools. Each CLI account has its own profile folder, so two Codex logins never mix. Keys are stored as plain text in `~/.omnitrix/secrets.json`, not in the operating system's keychain; on macOS and Linux only your user account can read the file, and on Windows omnitrix leaves its permissions as Windows sets them. Set `OMNITRIX_HOME` to keep omnitrix's data in another folder. If you use `--key-env`, omnitrix does not store the key at all, and when you give neither `--key` nor `--key-env`, `omnitrix add` uses the provider's usual environment variable if it is set. Avoid `--key <value>`, because the key then appears in your shell history.

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
| `pool_status` | Lists every account with its state, owner, models and remaining quota, and the named routes |
| `route_preview` | Shows which account would receive each task, and why, without running anything |
| `dispatch` | Sends up to 30 tasks at once and runs independent tasks in parallel |
| `get_results` | Waits for up to 50 jobs, 45 seconds by default and at most 110, and returns a short preview of each result, or the full results with `full` |
| `read_output` | Reads a full result in pages of 12,000 characters by default and at most 40,000 |
| `rate_result` | Accepts or rejects a result so that the router can learn from it, and can send a rejected task to another model |
| `cancel_job`, `list_jobs` | Cancels a job, its pending check or its running test, or lists the 20 most recent jobs (at most 100) |

Each task has a `title` of at most 200 characters, a `type`, a `prompt` and optionally an `acceptance` line, a `privacy` level, `files`, a `repo`, a `size` (`small`, `medium` or `large`), `use` to force an account or model, `effort`, `fast`, `route`, `escalate`, `output_schema`, `check`, `copies` and `follow_up_of` for tasks other than code and, for code tasks, `test`. `route_preview` accepts up to 30 tasks.

The `pool_status`, `dispatch` and `get_results` tools declare output schemas, and their structured data contains everything their text shows. `list_jobs` also lists jobs that other omnitrix processes started, and `cancel_job` can cancel them.

A task can set `effort` to `low`, `medium` or `high` to ask a reasoning model to think less or more. omnitrix passes it to Codex and to OpenAI-compatible APIs such as Gemini, but not to Anthropic-format APIs or to other agent CLIs; without it, each provider uses its own default. From the command line, use `omnitrix run --effort high`. Some models write their reasoning before the answer, such as Gemma 4 inside `<thought>` tags or DeepSeek R1 inside `<think>` tags; omnitrix removes such a block from the start of an answer from an OpenAI-compatible API, so that Claude receives only the answer.

### Checking and retrying results

A task can set `check` to `true` together with an `acceptance` line. When the result is ready, omnitrix sends a short review task to a different account. That task contains the instructions, the acceptance line and the result, with secrets removed and the result marked as data rather than instructions, and asks for PASS or FAIL with a one-sentence reason. Checks run only on models without tools, never on an agent CLI that can read files or run commands. `get_results` waits for this verdict and shows it next to the result, and the dashboard shows it on the row of the job that was checked. The check follows the privacy level of the task, so private work is checked only by an account that may receive private work. The checking model must also be about as good at review as the model that did the work: its estimated review fit may be at most 0.15 lower, so that a small model does not pass work it cannot judge. If no other suitable account is available, the check is reported as unavailable, with the reasons. The check uses the checking account's quota, and it reads the worker's report, not the changed files. It reads at most the first 4,000 characters of the instructions and 20,000 characters of the result. It is advice for Claude's own review and does not replace it.

When Claude rejects a result, it can call `rate_result` with `retry` set to `true` and a note that explains what was wrong. omnitrix then sends the same task to a model that has not been rejected for it, with the note added to the instructions. The new worker sees the note but not the rejected answer. A job is retried only once; to try again, rate the new job. A check job cannot be retried. A retry does not keep a forced `use`, and a task with `check` is checked again. The note can be up to 500 characters.

For an important review or question, a task can set `copies` to a number from 2 to 5. omnitrix then sends it to that many different models, choosing different accounts first, and returns one job per copy, with titles that end in `[1/3]`, `[2/3]` and so on. Each copy avoids the models picked for the others, so the answers are independent: a finding that several models report is more likely to be real, and one that only one model reports needs checking. Copies go only to models whose estimated fit for the task is at most 0.15 below the best candidate's, because a much weaker model adds noise rather than confidence. When fewer suitable models are available, fewer copies are made. Each copy uses its own quota, and code tasks cannot have copies, because they would change the same files.

To ask a worker more about its answer, a task can set `follow_up_of` to the id of a finished job. omnitrix sends it to the same model with that job's task, at most 8,000 characters, and the model's own answer, at most 20,000 characters, before the new prompt, so Claude does not need to repeat them and the worker continues where it stopped. A follow-up without a `privacy` level keeps the earlier task's level, and one with a level gets the stricter of the two, so a follow-up is never less private than the task it continues. If that model is not available, the follow-up fails rather than going to a model that never saw the conversation; Claude can then send a new task. Code jobs cannot be followed up, because their work is on their branch, not in their answer.

### How Claude stays fair when it judges other models

Claude makes the final decision about every result, so it could favour answers that look like its own. omnitrix gives it evidence that is not its own opinion. Each task can carry an `acceptance` line written before the work starts, so results are judged against what done means rather than against a preferred style. For code tasks, omnitrix runs the tests itself and lists the changed files, and a passing or failing test does not depend on anyone's taste. A `check` asks a different account, at most slightly weaker at that kind of task, to judge the result against the acceptance line, and `copies` asks several models the same question, so that a finding several of them report independently counts for more than any single view, Claude's included. This does not remove judgment from the process, but it makes Claude overrule tests and other models openly rather than quietly prefer its own style.

By default, previews are limited to 1,500 characters to keep Claude's token usage low; `omnitrix settings --preview-chars` changes the limit. Full outputs remain on disk.

## Commands

```
omnitrix init                   list what can be connected on this computer (--apply connects it, --no-open skips the dashboard)
omnitrix providers              list the providers you can connect (--free for free ones)
omnitrix add <provider>         connect an account (--label, --owner, --id, --key-env, --base-url, --model, --concurrency, limits)
omnitrix login <id>             sign in a CLI account in its own profile
omnitrix list                   show accounts, usage and remaining quota (also "status"; --json for machine-readable output)
omnitrix test <id>              send a small request to check an account (--model picks one); a model that gives an empty answer, or that the provider has retired, counts as failed and the next model is tried, unless --model names one
omnitrix test --all             check every enabled account in turn; exits with 1 when any fails, so it suits a weekly scheduled check
omnitrix set <id>               change limits, label, owner, key, base URL, priority, concurrency, --effort or --trains-on-data
omnitrix enable|disable <id>    enable or disable an account
omnitrix remove <id>            remove an account (--purge also deletes its login)
omnitrix models <id>            show model scores and rated jobs (--refresh queries the provider again)
omnitrix model <id> <model>     set scores or prices, or --add or --remove a model
omnitrix route <prompt>         show which model would receive a task (--type, --privacy, --fast, --route)
omnitrix run <prompt>           run one task and print the answer (--type, --privacy, --use, --repo, --effort, --fast, --route)
omnitrix routes                 list the named routes; "routes add <name>" and "routes remove <name>" manage your own
omnitrix settings               set the mode, private protection, pins, bans, the job time limit, the preview length, --open-dashboard, --auto-effort and --codex-tools
omnitrix dashboard              open the live dashboard on 127.0.0.1:4590, which runs in the background (--stop, --port, --no-open, --serve)
omnitrix setup-claude           register with Claude Code (--scope user|project|local, --no-statusline, --dry-run)
omnitrix mcp-config             print the MCP server entry for other apps, such as Cursor or VS Code
omnitrix team                   join, review or leave a team file, and show your spending (join --as, --yes; leave; status)
omnitrix usage                  requests, tokens and cost for the last 30 days (--by person|account|model, --days, --team)
omnitrix report                 what the workers did: jobs, how many Claude accepted, median time and tokens per model and task type (--days, --json)
omnitrix rebase <job>           replay a finished code job onto the current HEAD and check it again (--json)
omnitrix lockcheck [files]      show which packages a regenerated lockfile added, changed or removed (--base, --repo, --json)
omnitrix overhead               Claude's own tokens spent on omnitrix tool calls, from Claude Code's session files, next to the workers' accepted tokens (--days, --json)
omnitrix clean                  delete finished jobs and worktrees older than 14 days (--days, --dry-run, --branches)
omnitrix doctor                 check the setup, including whether each account's last request worked; it sends nothing
omnitrix mcp                    run the MCP server (Claude Code starts this itself)
omnitrix statusline             print the status line (Claude Code runs this itself)
```

Run `omnitrix <command> --help` for every option of a command. `omnitrix run` takes no `check`, `test`, `files` or `size`; those are set by Claude through `dispatch`.

`omnitrix clean` leaves alone any job that is still queued or running, and a finished job whose test or second-model check is still running in a live omnitrix process, whatever `--days` says. It also removes temp files that an interrupted save left in the omnitrix folder once they are older than the cutoff, and at least ten minutes old. omnitrix flushes each record to disk before it replaces the old one, so a power cut leaves either the old record or the new one.

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
| OpenCode | `opencode run --format json --model` with the task on standard input, checked with OpenCode 1.19.6 on Windows in real code jobs | |
| Antigravity CLI | Experimental, and not added by `omnitrix init`; `--mode accept-edits` for code tasks and `--model` follow the official documentation | reading the task from standard input |

The tests check every driver's flags and how it reads the documented answer format, and they run the Codex driver against a fake CLI. Only Codex has also been run in real jobs, so treat the others as less tested, and report a CLI that fails with the output of `omnitrix test <id>`.

## Tested with real accounts

Besides the automated tests, version 0.2.0 was checked in real use on Windows with three kinds of account: a ChatGPT Plus plan through Codex, a free Gemini API key, and Ollama with two small local models. On a sample project, omnitrix ran code jobs on Codex in their own worktrees with its own test run, reviews on Gemini, a retry that went to another model with the reason attached, a cancelled code job that freed its slot, a secret task and a picture-reading task that stayed on the local models, and a second-model check that reported itself unavailable when no account was strong enough. The live dashboard, quota readings, `omnitrix clean` and the other commands that existed in 0.2.0 were used on the same accounts. Commands added since then, such as `rebase`, `lockcheck`, `report` and `mcp-config`, are covered by the automated tests, and a code task through `rebase` was also checked by hand on a sample project. Other providers and agent CLIs are covered by the automated tests only. The same three were checked again in November 2026 with `omnitrix test --all`, and `omnitrix providers` marks them as tested with a real account.

Providers change their APIs without notice. When an account that worked before fails three times in a row with errors that are not rate limits, sign-in problems or network trouble, `omnitrix doctor` says so and suggests running `omnitrix test` on it, because that pattern usually means the provider changed something.

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
