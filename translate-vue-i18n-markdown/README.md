# translate-vue-i18n-markdown

A skill that translates the Markdown content files handled by [Nuxt Content's i18n integration](https://content.nuxt.com/docs/integrations/i18n) — the per-locale pages under `content/en/`, `content/fr/`, etc., plus the [`.navigation.yml`](https://content.nuxt.com/docs/utils/query-collection-navigation#navigation-metadata-with-navigationyml) directory-metadata files. It runs an extract script to find new or changed source files, has the agent translate each one directly while preserving frontmatter keys, code blocks, MDC components, and links, and runs a write script to record what's been translated for incremental runs.

> For JSON locale **message** files (`i18n/locales/*.json`), use the sibling [`translate-vue-i18n`](../translate-vue-i18n) skill instead.

## Install

Add to a project with [`npx skills`](https://github.com/anthropics/skills):

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n-markdown
```

Add globally (available in every project):

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n-markdown -g
```

Pin to a specific agent:

```bash
npx skills add nicolashmln/skills --skill translate-vue-i18n-markdown --agent claude-code
```

## Requirements

- **Node 24+** — the scripts are TypeScript and run directly via Node's native type stripping.
- No runtime dependencies.
- Content organized in per-locale subfolders (`content/<locale>/…`), per the Nuxt Content i18n convention.

## Usage

Once installed, just ask the agent:

- "Translate my Nuxt Content pages to French and Spanish"
- "Localize the content/ folder to German"
- "I added new English markdown pages, please translate them"

The skill follows a three-step workflow under the hood:

1. **Extract** — `node <skill>/scripts/extract.ts` walks `content/<source>/`, detects source and target languages from `nuxt.config.ts` or `i18n/i18n.config.ts`, and writes a manifest at `<content-root>/.metadata/.pending.json` listing only the `.md` and `.navigation.yml` files that need translating, with their source and target paths.
2. **Translate** — for each manifest entry, the agent reads the source file, translates it, and writes the result to the target path (mirroring the folder structure, keeping the filename).
3. **Write** — `node <skill>/scripts/write.ts` verifies the target files were written and updates the metadata so future runs are incremental.

## Metadata

The skill keeps four files in `<content-root>/.metadata/`:

- `translated.json` — flat array of source-relative file paths that have been translated, e.g. `["blog/post-1.md", "index.md"]`.
- `translated-langs.json` — array of language codes already processed, e.g. `["fr", "de"]`.
- `hashes.json` — flat map of file path to the SHA-1 of the **whole source file** at translation time, e.g. `{"index.md": "70f8bb…"}`. Extract uses this to detect when a source page has changed and re-queue it.
- `target-hashes.json` — per language, the SHA-1 of each translated file as of the last recorded source hash, e.g. `{"fr": {"index.md": "3c1d9e…"}}`. Extract uses this to tell a translation that was updated alongside its source from a stale one.

A file whose source matches its stored hash is skipped on the next extract. If the source page changes, extract picks it up automatically; pass `--force` to ignore all metadata and re-translate everything.

Sometimes the translation arrives with the source change, for example in a merged PR that edited both `content/en/guide.md` and `content/fr/guide.md` without updating `.metadata/`. In that case extract **adopts** the translation: it records the file as translated instead of re-queueing it. A changed page is adopted when its target also changed since the last snapshot. A new page is adopted when its target already exists. In both cases the target must differ from the source and pass the write step's structural validation. Extract lists every adopted file. One case gets adopted wrongly: a PR that changes a source page and also makes an unrelated edit to its translation, such as a typo fix.

When a source page is **deleted**, the next extract reconciles it automatically: it removes that page's translated copies from every language folder and prunes its `translated.json` / `hashes.json` / `target-hashes.json` entries, so removed pages don't leave orphaned translations behind. Files kept untranslated via `--exclude` are never affected (their source still exists), and this cleanup is skipped under `--force`.

The `.metadata/` folder is a dot-folder, so Nuxt Content ignores it and per-locale collections (`source.include: '<locale>/**'`) never match it. Commit it to share incremental tracking, or `.gitignore` it.

Upgrading from a version without `hashes.json`? On the first run, extract silently backfills hashes for files already in `translated.json` so existing translations aren't re-queued. `target-hashes.json` is backfilled the same way for every up-to-date translation. Until a page has a snapshot, a change to its source is always re-queued, never adopted.

## What's preserved during translation

Frontmatter keys, and these body tokens, stay byte-identical:

- Fenced code blocks (```` ``` ````) and inline code (`` `code` ``)
- URLs in links and images, and HTML attribute values
- MDC component names and prop keys (`::callout`, `:badge`, the `---` prop block) — only slot text and human-readable prop values are translated
- Frontmatter flags/IDs/dates (`navigation`, `draft`, `layout`, `slug`, `id`), brand and product names, code identifiers

Translated: frontmatter `title`/`description` and other prose, headings, paragraphs, list and table text, link text, and image alt text.

In `.navigation.yml` files, `title` and display text like `badge` are translated; keys, `icon` values, booleans, and custom flags are preserved.
