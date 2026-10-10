# Security Policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through this repository's **Security** tab, under **Report a vulnerability**. You'll get a response there.

Please include what you found, how to reproduce it, and what you think the impact is.

## Scope

The plugins run inside Claude Code on your own machine. The dock contacts one host, `api.anthropic.com`, to read your usage windows, using your existing Claude Code login. See PRIVACY.md for exactly what it reads, writes and sends.

Only the latest version on `main` is supported.

## Keep secrets out of reports

Don't paste tokens, keychain contents, `.env` files or your full `~/.claude` config into an issue or a report. If you've already shared one, rotate it.
