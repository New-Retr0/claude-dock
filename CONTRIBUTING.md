# Contributing

Thanks for looking at Claude Dock and Agent Model Badge. Both are unofficial community plugins for Claude Code and are not made by or affiliated with Anthropic.

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Check the README and PRIVACY.md. If your change alters what the dock reads, writes or sends, update both in the same pull request.
- Anything that changes how Claude works, or that is risky, should be off by default and behind a Settings option.

## Running the checks

From the repo root:

```sh
./scripts/test.sh                                  # both plugins' test suites
claude plugin validate --strict cc-dock            # manifest and hooks
claude plugin validate --strict agent-model-badge
```

All three must pass before a pull request is ready.

## Pull requests

- Branch from `main`, and keep each pull request to one focused change.
- Tests should assert what a user or caller can observe, not comments, phrases or identifiers.
- Keep comments short. A one-line "why" is enough where correct code looks wrong.
- Don't rename a published install name (`cc-dock`, `agent-model-badge`). Renaming it uninstalls the plugin for everyone who has it. Change `displayName` instead.
- Don't commit secrets, tokens or `.env` files.

Pull requests are squash-merged into `main`.

## Reporting bugs and ideas

Use the issue templates. For security problems, do not open a public issue; see [SECURITY.md](SECURITY.md).
