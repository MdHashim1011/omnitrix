# Contributing

Thanks for helping. A few things keep the project easy to work on.

## Setup

```bash
npm install
npm run build
npm test
```

## Adding a provider

Most providers only need an entry in `src/providers.ts`: an id, a name, the driver (`openai`, `anthropic` or `cli`), the base URL and the usual environment variable for the key. Please include a link to the provider's docs or terms in the pull request, and mark free tiers that may train on prompts with `trainsOnData: true`.

A new agent CLI needs an entry in `CLI_TOOLS` in `src/drivers/cli.ts`: how to run it headless, how to point it at a profile folder, and how to read its output. Add a test with a fake script like the one in `test/engine.test.ts`.

## Pull requests

- Keep changes focused. One feature or fix per pull request.
- Add or update tests.
- Run `npm test` on your machine first.
- When reporting a CLI problem, include the CLI's version (`codex --version`, `claude --version` and so on). Their output formats change often.

## What will not be merged

Features for importing or moving other people's credentials, getting around provider rate limits, or pooling free tiers to multiply quota.
