# Working on Claude Dock

This guide is for anyone changing these plugins, human or agent. It records the decisions behind them and the practices that keep them reliable. Read it before your first change.

## What's here

| Folder | Plugin | Install name |
| --- | --- | --- |
| `cc-dock/` | **Claude Dock**, the dashboard above the prompt | `cc-dock` |
| `agent-model-badge/` | **Agent Model Badge**, the model and effort on every subagent | `agent-model-badge` |

Both are Claude Code mods: hooks modules (`hooks/register.tsx` or `.ts`) that the engine loads from `hooks/hooks.json`, plus client modules for interactive pieces (`hooks/menu.tsx`, `chip.tsx`, `mascot.tsx`). `.claude-plugin/marketplace.json` makes this repo a marketplace.

## The rule: the engine is the source of truth

Before you keep any state of your own, look for where the engine already reports it, and read it from there. A mod that guesses drifts from what Claude Code really shows: it misses events from before it loaded, from other plugins and from the person's own keystrokes.

**How to look.** The engine writes its full API into each plugin's `.claude-plugin/types/claude-code/index.d.ts` when the plugin loads (about 14,000 lines; it is gitignored). Search it for the noun or event you need (`'session.`, `'turn.`, `classic.`, a render component such as `PromptHint: {`) and read the doc comment.

**Where the truth usually lives:**

| Need | Read it from |
| --- | --- |
| The model in use | `$.session.model()`, checked every second, and each `turn.step`'s `model` |
| The effort of a request | `turn.step`'s `effort` |
| Whether a turn is running | `PromptHint`'s `isWorking` on every redraw; `turn.step` and `turn.complete` only as hints |
| The permission mode | `PromptHint`'s `hint` text (`⏵⏵ bypass permissions on`) |
| Background shells and tasks | the footer's count in `PromptHint`'s `hint` (`· 1 shell ·`) and the `background_tasks` list on `classic.Stop` and `classic.SubagentStop` |
| Context and cost | `$.session.usage()` |
| A subagent's resolved model | `agent.spawn`'s result |
| Settings | `$.config.list()` and `~/.claude/settings.json` |

**When the engine exposes nothing,** read the engine's own words rather than inventing state: ultracode and fast mode are known only from what `/effort` and `/fast` print. Say so in a comment, and re-check whenever a new engine version lands, since a new event or prop may replace the workaround.

**Re-read; don't remember.** Prefer a value read on each redraw or a short timer over one cached at load. A reload, a resumed session or a hook that missed an event must not leave the dock showing something false.

## Design principles

- **Never get in the way.** The dock must not block typing, steal keys or add hotkeys a person could hit by accident. Engine commands the dock runs (`/effort`, `/fast`, `/compact`) wait until the session is idle rather than queuing behind a prompt.
- **No noise in the transcript.** A plugin's failure prints a line in the person's transcript. Guard every engine call that can fail: post a notice only under a call that is still open, catch audio and network errors quietly, and never log routine state.
- **Risky or opinionated behaviour starts off.** Bypass needs a confirm. Backgrounding servers and watchers is off by default. Anything that changes how Claude works is opt-in.
- **Settings live in Settings → Dock**, in titled groups (HEADER, TOP LINE, AVATAR, SHELLS, UI, SOUND). Every choice previews or applies at once, and is kept in `$.store` by name, never by list position, so changing a list can't swap someone's choice.
- **Colour comes from theme keys** (`claude`, `success`, `warning`, `error`, `permission`, `text`) where possible, so the dock follows the person's theme. Use hex only for fixed brand moments, such as ultracode's purple or the sparkler's gold.
- **The terminal has rules of its own.** Button labels can't be bold or coloured, and leading spaces are trimmed, so pad with no-break spaces. The engine folds whitespace runs in task descriptions, so a visible gap needs a non-space blank such as U+2800. Measure every line against the band's width.
- **The mascot is a companion, not a distraction.** Easter eggs finish before another starts, never play during a scene, and the rare ones stay rare. The talking head lifts one row, with an empty gap below.
- **Disclose everything.** Each plugin's README has a "What it reads, writes and sends" section. Any new file read, file write, network request, command or sound must be added there in the same change.

## Writing code

- **One hook per event.** The engine refuses a second unmatched hook on the same event. Extend the existing `classic.Stop` or `tool.call { tool: 'Bash' }` hook instead of adding another.
- **Reserved names.** In hooks modules, `on` and `next` can't be redeclared as parameters or bindings.
- **Client modules.** Props can't contain `undefined`; pass `null`. The `surface` object is frozen, so keep per-instance data in a `WeakMap` keyed by it. Stamp client keys with the load time (`LOAD`) so a hot reload starts fresh instances.
- **Time.** Use `$.clock` in hooks. In a client module, drive time-locked animation (the talking mouth) from elapsed real time, because timers drift under load.
- **Comments earn their place.** A short `why` where correct code looks wrong; nothing that restates the code.

## Testing

Every change ships with a test that fails without it. Check that by disabling your fix and watching the test fail.

```bash
scripts/test.sh                     # every plugin's behaviour tests (or: scripts/test.sh cc-dock)
claude plugin validate --strict cc-dock
```

Tests live in `tests/<plugin>/`, outside the plugin folders, so they don't ship to the people who install a plugin and the directory doesn't scan their stand-in hooks as plugin code. `claude plugin test` only reads tests inside a plugin's folder, so `scripts/test.sh` copies each plugin and its tests to a scratch folder and runs them there. Never add a `tests/` folder inside a plugin.

- Assert what a person would see or hear: a rendered text, a played asset, a rewritten tool call. Never assert on source text.
- Tests run against a mocked clock, but every dock timer still fires. Keep each test under the kit's 5-second limit: simulate the fewest minutes the behaviour needs, and unmount the band while time passes.
- To try a change in a real session without touching your own setup, start one that ignores user settings and loads only what you pass: `claude --setting-sources project,local --plugin-dir ./cc-dock`. Otherwise a demo session can write into your real dock's saved settings.

## Naming and publishing

- **Install names can't start with `claude-`, `anthropic-` or `cc-plugin-`.** Claude Code reserves them for Anthropic's own plugins. A display name (`"displayName": "Claude Dock"`) may say Claude, but Anthropic's directory may still hold it for review.
- **Never rename a published install name.** It uninstalls the plugin for everyone who has it. Change `displayName` instead, or use the marketplace's `renames` map.
- **Bundled media goes in each plugin's `assets/` or `sounds/`.** Only ship audio you're allowed to redistribute, and keep its license file next to it, as with `sounds/KENNEY-LICENSE.txt`.
- **Before a release:** tests and strict validation pass, the READMEs describe the new behaviour, the disclosure section is current, and `version` in `plugin.json` is raised.
