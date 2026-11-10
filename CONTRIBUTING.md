# Contributing

Thank you for your interest in contributing. The guidelines below help keep the project maintainable.

## Setup

```bash
npm install
npm run build
npm test
```

## Adding a provider

Most providers require only an entry in `src/providers.ts`: an ID, a name, the driver (`openai`, `anthropic` or `cli`), the base URL and the environment variable that typically holds the key. Please link to the provider's documentation or terms in your pull request. If its free tier may train on prompts, set `trainsOnData: true`.

A new agent CLI belongs in `CLI_TOOLS` in `src/drivers/cli.ts`. The entry must define how to run the tool without a terminal, how to point it at a profile folder and how to read its output. Please include a test that uses a fake script, following the example in `test/engine.test.ts`.

## Pull requests

Limit each pull request to one change, include tests, and run `npm test` before you open it. When reporting a problem with an agent CLI, please include its version (`codex --version`, `claude --version` and so on), because output formats change often.

## Out of scope

The project will not accept changes that import or transfer other people's credentials, circumvent a provider's rate limits, or combine free tiers to multiply quota.
