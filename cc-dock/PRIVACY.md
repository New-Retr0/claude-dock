# Claude Dock privacy policy

Effective 7 October 2026.

Claude Dock is a Claude Code plugin that draws a dashboard above your prompt. It runs entirely on your own machine. It has no servers of its own, collects no analytics, and sends nothing to its author.

## What it reads

- **Your plan's usage limits.** About once a minute while a session is open, and at most once a minute after each model response, it requests them from `https://api.anthropic.com/api/oauth/usage`, the same endpoint Claude Code's `/usage` command uses. The request is authenticated with the Claude Code login already on your machine, read from the macOS keychain or `~/.claude/.credentials.json`. The token is held in memory for that request only and is never logged, displayed or stored. Anthropic's handling of that request is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- **Local Claude Code files:** `~/.claude/stats-cache.json`, `~/.claude/sessions/*.json`, `~/.claude/settings.json`, the account block of `~/.claude.json`, and background shell output. It uses these to draw stats, session names, your account's display name and each shell's latest output. They are read on your machine and never sent anywhere.

## What it stores

- **Your dock settings,** such as colours, sounds and which sections are open, in Claude Code's local plugin store on your machine.
- **Nothing else.** It changes no Claude Code settings. The one file it can create is an empty `/tmp/cc-dock-bypass-probe`, only if you show the optional Bypass button and confirm it. Picking an effort level runs Claude Code's own `/effort` command, which saves the level as it normally does.

Usage figures and everything else it reads stay in memory for the current session.

## What it sends

Only the usage request described above, to Anthropic. There is no other network destination.

## Children

Claude Dock is not intended for people under 18.

## Questions

Open an issue at <https://github.com/New-Retr0/claude-dock/issues>.
