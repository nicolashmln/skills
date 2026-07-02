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

The skill keeps three files in `<content-root>/.metadata/`:

- `translated.json` — flat array of source-relative file paths that have been translated, e.g. `["blog/post-1.md", "index.md"]`.
- `translated-langs.json` — array of language codes already processed, e.g. `["fr", "de"]`.
- `hashes.json` — flat map of file path to the SHA-1 of the **whole source file** at translation time, e.g. `{"index.md": "70f8bb…"}`. Extract uses this to detect when a source page has changed and re-queue it.

A file whose source matches its stored hash is skipped on the next extract. If the source page changes, extract picks it up automatically; pass `--force` to ignore all metadata and re-translate everything.

The `.metadata/` folder is a dot-folder, so Nuxt Content ignores it and per-locale collections (`source.include: '<locale>/**'`) never match it. Commit it to share incremental tracking, or `.gitignore` it.

Upgrading from a version without `hashes.json`? On the first run, extract silently backfills hashes for files already in `translated.json` so existing translations aren't re-queued.

## What's preserved during translation

Frontmatter keys, and these body tokens, stay byte-identical:

- Fenced code blocks (```` ``` ````) and inline code (`` `code` ``)
- URLs in links and images, and HTML attribute values
- MDC component names and prop keys (`::callout`, `:badge`, the `---` prop block) — only slot text and human-readable prop values are translated
- Frontmatter flags/IDs/dates (`navigation`, `draft`, `layout`, `slug`, `id`), brand and product names, code identifiers

Translated: frontmatter `title`/`description` and other prose, headings, paragraphs, list and table text, link text, and image alt text.

In `.navigation.yml` files, `title` and display text like `badge` are translated; keys, `icon` values, booleans, and custom flags are preserved.
