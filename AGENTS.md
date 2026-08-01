# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`, organized by responsibility: `agent/` contains the runtime loop, `model/` wraps the Anthropic SDK, `tools/` defines tool registration and project-safe file access, and `state/` and `observability/` hold checkpoints and events. Public exports belong in `src/index.js`. Tests mirror these areas under `test/`; reusable deterministic doubles live in `test-utils/`. Runnable lessons are in `examples/`, while lesson notes and the learning roadmap are in `docs/`.

## Build, Test, and Development Commands

This repository requires Node.js 20 or newer and has no compile step.

- `npm install` installs the locked dependencies from `package-lock.json`.
- `npm test` runs all tests once with Node's built-in test runner.
- `npm run test:watch` reruns affected tests during development.
- `npm run lesson:01 -- "Read package.json"` runs the first agent-loop example with a prompt.

The lesson command reads Claude authentication, base URL, and model settings from `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`). Tests do not require live model access.

## Coding Style & Naming Conventions

Use ESM imports/exports, two-space indentation, semicolons, single quotes, and trailing commas in multiline literals. Follow existing naming: kebab-case filenames (`coding-agent.js`), PascalCase classes (`CodingAgent`), camelCase functions and variables, and descriptive dot-separated event names (`run.started`). Keep modules focused and expose supported APIs through `src/index.js`. There is no configured formatter or linter, so match nearby code and keep JSDoc useful at public boundaries.

## Testing Guidelines

Write tests with `node:test` and `node:assert/strict`. Name files `*.test.js` and place them in the matching `test/` subtree. Prefer deterministic fakes over network requests; use `test-utils/model/fake-anthropic-client.js` for model interactions. Assert observable outcomes such as final status, message history, tool calls, events, checkpoints, and failure behavior. No numeric coverage threshold is configured, but every behavior change should include a regression test.

## Commit & Pull Request Guidelines

Current history uses concise, imperative commit subjects (for example, `add agent loop`). Keep each commit scoped to one logical change. Pull requests should explain the motivation and behavior change, list verification commands, link relevant issues, and update lesson documentation when APIs or learning steps change. Include screenshots only for visual documentation changes, and never commit credentials or local Claude settings.
