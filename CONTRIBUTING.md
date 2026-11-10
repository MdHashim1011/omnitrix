# Contributing

Thanks for wanting to help. Here's what keeps the project easy to work on.

## Setup

```bash
npm install
npm run build
npm test
```

## Adding a provider

Most providers only need an entry in `src/providers.ts`: an id, a name, the driver (`openai`, `anthropic` or `cli`), the base URL and the environment variable people usually keep the key in. Link the provider's docs or terms in your pull request. If its free tier may train on prompts, set `trainsOnData: true`.

A new agent CLI goes in `CLI_TOOLS` in `src/drivers/cli.ts`. It needs to know how to run the tool without a terminal, how to point it at a profile folder and how to read its output. Please add a test with a fake script, like the one in `test/engine.test.ts`.

## Pull requests

Keep each pull request to one change, with tests, and run `npm test` before you open it. If you're reporting a problem with an agent CLI, include its version (`codex --version`, `claude --version` and so on), since their output formats change often.

## What won't be merged

Anything that imports or moves other people's credentials, works around a provider's rate limits, or pools free tiers to multiply quota.
