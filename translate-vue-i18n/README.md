# translate-vue-i18n

A skill that translates Vue i18n / Nuxt i18n JSON locale files. It runs an extract script to find missing keys, hands them to the agent for translation while preserving Vue i18n syntax (`{var}` interpolation, `|` pluralization, `@:linked.keys`, HTML), and runs a write script to merge the results back.

## Install

Add to a project with [`npx skills`](https://github.com/anthropics/skills):

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n
```

Add globally (available in every project):

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n -g
```

Pin to a specific agent:

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n --agent claude-code
```

## Requirements

- **Node 24+** — the scripts are TypeScript and run directly via Node's native type stripping.
- No runtime dependencies.

## Usage

Once installed, just ask the agent:

- "Translate my locales to French and Spanish"
- "Sync the missing French translations"
- "I added new keys to my English locale, please translate them"

The skill follows a three-step workflow under the hood:

1. **Extract** — `node <skill>/scripts/extract.ts` walks `i18n/locales/` (or `locales/`), detects source and target languages from `i18n/i18n.config.ts` or `nuxt.config.ts`, and writes a pending file at `<locales-root>/.metadata/.pending.json` listing only the keys that need translating.
2. **Translate** — the agent edits the pending file in place, replacing source values with target-language translations.
3. **Write** — `node <skill>/scripts/write.ts` deep-merges translations into the target locale files and updates the metadata so future runs are incremental.

## Metadata

The skill keeps three files in `<locales-root>/.metadata/`:

- `translated.json` — flat array of dotted key paths that have been translated, e.g. `["nav.home", "errors.email_taken"]`.
- `translated-langs.json` — array of language codes already processed, e.g. `["fr", "es"]`.
- `hashes.json` — flat key/value map of dotted key paths to the SHA-1 of the source value at translation time, e.g. `{"nav.home": "70f8bb..."}`. Extract uses this to detect when the source English text has changed and re-queue those keys.

A key whose source value matches its stored hash is skipped on the next extract. If the source English text changes, extract picks it up automatically; pass `--force` to ignore all metadata and re-translate everything.

Upgrading from a version of this skill without `hashes.json`? On the first run, extract silently backfills hashes for keys already in `translated.json` so existing translations aren't re-queued.

## Vue i18n syntax preserved

These tokens are runtime-significant and stay byte-identical across translation:

- Named interpolation — `{name}`, `{count}`, `{userName}`
- List interpolation — `{0}`, `{1}`
- Pluralization — `|`-separated variants (same count as source)
- Linked messages — `@:key.path`, `@.lower:`, `@.upper:`, `@.capitalize:`
- HTML tags, attributes, URLs, and email addresses
