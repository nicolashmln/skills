---
name: translate-vue-i18n-markdown
description: Translate Markdown content files handled by Nuxt Content's i18n integration. Use this skill whenever the user asks to translate, localize, or add a language to the Markdown pages under a Nuxt `content/` folder organized by locale (`content/en/`, `content/fr/`, …), or when they mention missing translations, syncing localized content, or adding language support for their Nuxt Content docs/blog/site. Also use it for phrases like "translate my Nuxt Content markdown", "localize the content/ folder to French", "add German to my docs content", "I added new English pages, translate them", or "sync the missing French markdown". The skill runs an extract script to find new/changed source `.md` files and `.navigation.yml` directory-metadata files, has you translate each file directly (preserving frontmatter keys, code blocks, MDC components, links, and URLs), and runs a write script to record what's been translated in a `.metadata/` folder for incremental runs. For JSON locale message files (`i18n/locales/*.json`) use the `translate-vue-i18n` skill instead.
---

# translate-vue-i18n-markdown

Translate Nuxt Content Markdown files in three steps: **extract → translate → write**.

This skill targets the [Nuxt Content i18n](https://content.nuxt.com/docs/integrations/i18n) layout, where localized content lives in per-locale subfolders that mirror the same structure:

```
content/
  en/index.md   en/about.md   en/blog/.navigation.yml   en/blog/post-1.md
  fr/index.md   fr/about.md   fr/blog/.navigation.yml   fr/blog/post-1.md
```

The extract and write steps are TypeScript scripts in this skill's `scripts/` folder. They run on Node 24 directly (no compile step — Node strips types natively). Both scripts operate on `process.cwd()`, so run them from the project root.

> Translating JSON locale *message* files (`i18n/locales/*.json`, `{var}` interpolation, `|` pluralization)? Use the sibling **translate-vue-i18n** skill instead. This skill is for Markdown content pages.

## Step 1: Extract

Run the extract script from the project root:

```bash
node "<this-skill-path>/scripts/extract.ts"
```

Replace `<this-skill-path>` with the absolute path to this skill's folder.

Optional flags:
- `--source <lang>` — override detected source language
- `--targets a,b,c` — override target languages (comma-separated)
- `--force` — re-translate every file into the target languages (forgets their recorded metadata)
- `--cwd <path>` — operate on a different directory
- `--content-dir <dir>` — content root, default `content`
- `--exclude a/,b/` — skip source paths with these prefixes (comma-separated, relative to `content/<source>/`). Use for sections that intentionally stay untranslated, e.g. `--exclude internal/`; excluded files never enter the pending manifest.

If the user names specific languages ("translate to French and Spanish", "add German"), pass them via `--targets fr,es` or `--targets de`. Auto-detection only finds languages that already have a config entry or an existing subfolder, so a fresh language always needs `--targets`.

What the script does:
1. **Locates the content root** (`content/` by default; `--content-dir` to override).
2. **Detects languages** from `nuxt.config.ts` or `i18n/i18n.config.ts` (looks for `defaultLocale` and `i18n.locales`, handling both `{ code: 'en' }` objects and `'en'` strings). Falls back to the locale subfolder names under the content root; defaults source to `en` if present.
3. **Walks translatable files** recursively under the source-language folder (`content/<source>/`): markdown files (`.md`, `.markdown`) plus Nuxt Content's [`.navigation.yml` / `.navigation.yaml`](https://content.nuxt.com/docs/utils/query-collection-navigation#navigation-metadata-with-navigationyml) directory-metadata files — the only dotfiles included; everything else starting with `.` is skipped.
4. **Diffs** each file against `<content-root>/.metadata/translations.json`, which holds one record per language and source-relative path: `{ "fr": { "blog/post-1.md": { "source": "<sha1>", "target": "<sha1>" } } }`, the SHA-1s of the **whole** source file and of its translation when that translation was recorded. Each language is diffed on its own:
   - If the language has **no key** in `translations.json` → queue (a fresh language gets every file).
   - Else if the path has **no record** for that language → new page: **adopt** it if the target file already exists, differs from the source, and passes write-step validation; otherwise queue.
   - Else if the record's `source` differs from the current source's SHA-1 → source page changed: **adopt** it if the target also changed since its recorded `target` hash (and differs from the source and passes validation); otherwise queue.
   - Else → skip. If the target was edited on its own, its recorded `target` hash is updated, so a later source change isn't mistaken for one already translated.

   **Adoption** covers translations updated outside the skill, typically a merged PR that edited both `content/en/x.md` and `content/fr/x.md` without updating `.metadata/`. The target is kept as-is and recorded for that language, with no re-translation. The rule is a heuristic: a PR that changes the source *and* makes an unrelated edit to the translation (e.g. a typo fix) gets adopted too, so extract lists every adopted file under `Adopted N translation(s)…`. A translation that failed validation in the write step fails it here too, so it's re-queued, not adopted.
5. **Reconciles deletions.** Any path recorded in `translations.json` whose source file no longer exists under `content/<source>/` is orphaned: its translated copies are deleted from **every** established language folder and its records are pruned. Excluded files (`--exclude`) are unaffected — their source still exists. This runs automatically on every extract, including under `--force`. It never runs when the source folder has no files (a safety valve against a misdetected content root deleting everything).
6. **Writes** a manifest to `<content-root>/.metadata/.pending.json`:

```json
{
  "sourceLang": "en",
  "extractedAt": "2026-06-28T12:00:00.000Z",
  "contentRoot": "content",
  "files": [
    {
      "lang": "fr",
      "relPath": "blog/post-1.md",
      "sourcePath": "content/en/blog/post-1.md",
      "targetPath": "content/fr/blog/post-1.md",
      "reason": "new"
    }
  ]
}
```

If the script reports `Total files to translate: 0`, there's nothing to translate — but first check its output for `Migrated legacy metadata…`, `Deleted N orphaned translation(s)…` and `Adopted N translation(s)…` lines. If it did any of those, report it to the user; only stop silently when nothing was translated, migrated, deleted, **or** adopted.

## Step 2: Translate

Read `<content-root>/.metadata/.pending.json`. For **each** entry in `files`:
1. **Read** `sourcePath` (the source-language `.md` or `.navigation.yml`).
2. Translate its content into the entry's `lang` (see rules below).
3. **Write** the translation to `targetPath`. Keep the **same folder structure and filename** — `content/en/blog/post-1.md` → `content/fr/blog/post-1.md`. Create parent folders as needed.

Translate files directly with Read/Write — do **not** put markdown inside the pending JSON. For consistency, before translating, briefly skim sibling files already in `<content-root>/<lang>/` (if any) to match terminology.

### What to translate vs. preserve

Mistranslating structural tokens breaks the page (broken components, dead links, invalid frontmatter), often silently at build time.

- **Frontmatter (YAML between the leading `---` fences):**
  - Translate human-readable **values**: `title`, `description`, and other prose fields (e.g. `summary`, `seo.title`, `seo.description`).
  - Keep all **keys** unchanged.
  - Do **not** translate: booleans, numbers, dates; flags like `navigation`, `draft`, `layout`; component/layout names; `id`; `slug` / path-affecting fields (changing them alters routing — leave them unless the user asks); image paths and URLs.
  - Translated values must remain **valid YAML** — two traps: inside a single-quoted scalar, double any apostrophe the translation introduces (`title: 'Qu''est-ce que X ?'`); and if a translated value gains a colon-space (e.g. an English ` — ` rendered as `: ` in Spanish), wrap the whole value in quotes, or YAML parses it as a nested mapping and the page renders `[object Object]`.
  - The file must start with the opening `---` at the **first byte** — no leading blank lines, or Nuxt Content ignores the frontmatter entirely.
- **Markdown body — translate:** headings, paragraphs, list items, table cell text, link text, image alt text, blockquotes.
- **Markdown body — preserve byte-for-byte:**
  - **Fenced code blocks** (```` ``` ````) and **inline code** (`` `code` ``) — content stays exactly as-is.
  - **URLs** in links and images (`[text](/url)` → translate `text`, keep `/url`), and **HTML attribute values**.
  - **MDC components** — component names and prop **keys** stay unchanged: block `::callout` … `::`, inline `:badge`, and the YAML-ish prop block delimited by `---` inside a component. Keep structural prop values (`icon`, `variant`, `color`, `class`, `to`, `size`) as-is; translate only human-readable prop values (e.g. a `title:` prop) and the component's slot/body text.
  - **Brand and product names, code identifiers** — don't translate.
- **`.navigation.yml` / `.navigation.yaml` files** (Nuxt Content directory metadata) are plain YAML:
  - Translate human-readable **values**: `title`, and display text like `badge` under `navigation:`.
  - Keep all **keys** unchanged, and preserve structural values as-is: `icon` (e.g. `i-lucide-square-play`), booleans like `section: true`, numbers, paths/URLs, and any custom flags whose values aren't prose.
  - A file with no prose values (e.g. icon-only) is copied unchanged — that's fine; the write step's byte-identical warning is expected there.
- Translating a heading changes its auto-generated anchor — that's expected and correct for a localized page.

### Style

- Match the register of the source (formal vs. casual).
- Use the conventional translation in the target language ecosystem rather than a literal one.
- Reuse terminology already established in sibling files in the same language folder.

## Step 3: Write

```bash
node "<this-skill-path>/scripts/write.ts"
```

Optional flags: `--cwd <path>`, `--content-dir <dir>` (match what you passed to extract).

What the script does:
1. Reads `<content-root>/.metadata/.pending.json`.
2. For each entry, **verifies** the `targetPath` now exists. If a target is missing, it warns and does **not** record it, so the next extract re-queues it.
3. **Validates** each target structurally and refuses to record failures (warned, not recorded): frontmatter must open at byte 0 and close when the source has one; the target can't have fewer headings/images than the source or be under half its line count (truncation signals); single-quoted YAML values must have doubled apostrophes, and plain values no unquoted `: `. A flagged file stays on disk but unrecorded, so the next extract re-queues it — either fix the file right away and re-run extract + write, or just let the re-queue re-translate it.
4. **Warns** if a translated file is byte-identical to its source (often a missed translation; sometimes legitimate, e.g. a code-only page) — but records it anyway.
5. **Updates** the metadata:
   - Records `{ source: sha1(sourceFile), target: sha1(targetFile) }` under `lang → path` in `<content-root>/.metadata/translations.json` (sorted keys). Future extracts compare against it to re-queue stale translations and adopt ones updated alongside their source.
   - Records are per language: a file that's missing or fails validation in one language is re-queued for that language only, even when other languages recorded the same path. A fresh language gets its key on its first recorded file, so a run where every target was missing leaves it fresh.
6. **Deletes** the pending file.

Upgrade note: earlier versions kept shared metadata in `translated.json`, `translated-langs.json`, `hashes.json` and `target-hashes.json`. The next extract (or write) migrates them to `translations.json` and deletes them, logged as `Migrated legacy metadata…`. It builds a record for every translated path whose target exists in each recorded language. Where the old files had no hash, it uses the current source hash, and the target's current hash. A translation missing on disk gets no record, so it's re-queued. Without a stored target hash, a page whose source changed before the migration is re-queued rather than adopted.

## Reporting back to the user

After `write.ts` finishes, summarize briefly:
- How many files were translated, into which languages.
- Any orphaned translations the extract step deleted because their source page was removed (from its `Deleted N orphaned translation(s)…` output), and that their metadata was pruned.
- Any translations the extract step adopted instead of re-translating (from its `Adopted N translation(s)…` output). List them, so the user can check that each one really reflects the new source.
- Any warnings the writer printed (missing targets, validation failures, byte-identical files). If a file failed validation, say why and that it will re-queue on the next run.
- The estimated token count from the writer's last line (`Estimated tokens used for translation: ~X`) — pass it through verbatim; it's a rough estimate, so don't dress it up.
- If extract printed `Migrated legacy metadata…`, that the old metadata files were replaced by `translations.json`, so the user expects that change in their diff.
- That `.metadata/` now tracks what's been translated, so subsequent runs are incremental.

## Notes

- The scripts have zero dependencies — only Node 24+ built-ins (`node:fs/promises`, `node:crypto`, `node:path`). `scripts/shared.ts` holds the metadata handling and structural checks shared by both scripts.
- Config detection uses regex over `nuxt.config.ts` and `i18n/i18n.config.ts` (handles `defaultLocale: 'en'` and `locales: [{ code: 'en' }, …]` or `locales: ['en', …]`). If detection fails, the script falls back to locale subfolder names — pass `--source` / `--targets` to override.
- The `.metadata/` folder lives under the content root but is a dot-folder, so Nuxt Content ignores it, and per-locale collections (`source.include: '<locale>/**'`) never match it. Commit it to share incremental tracking across contributors, or `.gitignore` it if you prefer not to.
