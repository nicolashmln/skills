---
name: translate-vue-i18n
description: Translate Vue i18n / Nuxt i18n JSON locale files. Use this skill whenever the user asks to translate, localize, or add a language to a Vue or Nuxt project's i18n locale files (typically under `i18n/locales/` or `locales/`), or when they mention missing translations, syncing translations across languages, or adding new language support. Also use it for any phrase like "translate my locales", "fill in the French translations", "I added new keys, translate them", or "add Spanish to my Nuxt app". The skill runs an extract script to find missing keys, translates them while preserving Vue i18n syntax (`{var}` interpolation, `|` pluralization, `@:linked.keys`, HTML), and runs a write script to merge results back and track what's been translated in a `.metadata/` folder for incremental runs.
---

# translate-vue-i18n

Translate Vue i18n JSON locale files in three steps: **extract → translate → write**.

The extract and write steps are TypeScript scripts in this skill's `scripts/` folder. They run on Node 24 directly (no compile step — Node strips types natively). Both scripts operate on `process.cwd()`, so run them from the project root.

## Step 1: Extract

Run the extract script from the project root:

```bash
node "<this-skill-path>/scripts/extract.ts"
```

Replace `<this-skill-path>` with the absolute path to this skill's folder.

Optional flags:
- `--source <lang>` — override detected source language
- `--targets a,b,c` — override target languages (comma-separated)
- `--force` — re-translate everything (ignore metadata)
- `--cwd <path>` — operate on a different directory

If the user names specific languages in their request ("translate to French and Spanish", "add German"), pass them via `--targets fr,es` or `--targets de`. Auto-detection only finds languages that already have a config entry or an existing subfolder, so a fresh language always needs `--targets`.

What the script does:
1. **Locates the locales root** by checking, in order: `i18n/locales/`, then `locales/`.
2. **Detects languages** from `i18n/i18n.config.ts` or `nuxt.config.ts` (looks for `defaultLocale` and `locales`). Falls back to subfolder names if neither config exists; defaults source to `en` if present.
3. **Walks JSON files** recursively under the source-language folder.
4. **Diffs** against `<locales-root>/.metadata/translated.json` and `<locales-root>/.metadata/translated-langs.json`:
   - If a target language is **not** in `translated-langs.json`, every source key is queued for that language (fresh language).
   - If a target language **is** in `translated-langs.json`, only source keys absent from `translated.json` are queued for that language.
5. **Writes** a pending file to `<locales-root>/.metadata/.pending.json`:

```json
{
  "sourceLang": "en",
  "extractedAt": "2026-04-29T12:00:00.000Z",
  "languages": {
    "fr": {
      "common.json": {
        "greeting": "Hello",
        "nav": { "home": "Home" }
      }
    },
    "es": {
      "common.json": { "greeting": "Hello" }
    }
  }
}
```

If the script reports `Total keys to translate: 0`, stop and tell the user there's nothing to translate.

## Step 2: Translate

Read `<locales-root>/.metadata/.pending.json` and replace each leaf string under `languages.<lang>.<file>` with the translation in that target language. **Keep the structure identical — only the leaf string values change.** Edit the pending file in place.

For consistency, before translating a file, briefly skim sibling files already in `<locales-root>/<lang>/` (if any) to match terminology.

### Vue i18n syntax — what NOT to change

These tokens are runtime-significant. Mistranslating them breaks the app at runtime, often silently. The reason for each rule is that Vue i18n parses the string at lookup time using exact characters.

- **Named interpolation** — `{name}`, `{count}`, `{userName}`. The variable name inside braces must be byte-for-byte identical in the translation.
  - `"Hello {name}"` → `"Bonjour {name}"` ✅
  - `"Hello {name}"` → `"Bonjour {nom}"` ❌ (variable doesn't exist at runtime)
- **List interpolation** — `{0}`, `{1}`, etc. Keep the indices and their order if possible; if the target language requires reordering, the indices may move but the digits must stay the same.
- **Pluralization** — Variants separated by `|` (typically with surrounding spaces). Translate each variant and keep the same number of variants and the `|` separator.
  - `"no items | one item | {count} items"` → `"aucun élément | un élément | {count} éléments"`
  - Some languages (Russian, Polish, Arabic) need more variants for correct grammar, but the source decides the count — match it. The user can adjust pluralization rules later if needed.
- **Linked messages** — `@:key.path`, `@.lower:key.path`, `@.upper:key.path`, `@.capitalize:key.path`. The key path after `@:` (or `@.modifier:`) refers to another translation key and must be left exactly as-is.
  - `"See @:nav.home for more"` → `"Voir @:nav.home pour plus"` ✅
- **HTML tags and attributes** — Translate text content; leave tag names, attribute names, attribute values (URLs, classes, IDs) untouched.
  - `"<a href=\"/about\" class=\"link\">About us</a>"` → `"<a href=\"/about\" class=\"link\">À propos</a>"`
- **URLs, email addresses, code identifiers, brand and product names** — Don't translate.

### Style

- Match the register of the source (formal vs casual). UI strings are usually formal-neutral.
- Use the conventional UI translation in the target language ecosystem (e.g. "Settings" → "Paramètres" in French) rather than literal translations.
- If a term has already been translated in a sibling file in the same language folder, reuse that translation for consistency.

## Step 3: Write

```bash
node "<this-skill-path>/scripts/write.ts"
```

What the script does:
1. Reads `<locales-root>/.metadata/.pending.json`.
2. **Deep-merges** translations into each `<locales-root>/<lang>/<file>`, creating files and folders as needed. Existing keys not in the pending set are preserved (so prior manual edits aren't clobbered).
3. **Updates** the metadata:
   - Adds every translated dotted key path to `<locales-root>/.metadata/translated.json` (a sorted JSON array of strings like `"nav.home"`, `"errors.email_taken"`).
   - Adds each target language to `<locales-root>/.metadata/translated-langs.json` (a sorted JSON array like `["de", "fr"]`).
4. **Warns** if any translated value is byte-identical to the source (often a missed translation; sometimes legitimate, e.g. proper names like "Vue").
5. **Deletes** the pending file.

Implication: the skill assumes Vue i18n's convention that all locale files in a folder share one global namespace, so dotted key paths are unique across files. If the same dotted path appears in two source files and only one is translated, the path will be marked translated and the second file will not be retranslated for that key. In practice, projects don't duplicate keys across files.

Note: the metadata does **not** track when a source value changes. If the English text for a key changes after it's been translated, the skill will not re-translate it. To force a re-translation, pass `--force` to extract, or remove the relevant entry from `translated.json` by hand.

## Reporting back to the user

After `write.ts` finishes, summarize briefly:
- How many keys were translated, into which languages, in which files.
- Any warnings the writer printed.
- That `.metadata/` now tracks what's been translated, so subsequent runs are incremental.

## Notes

- The scripts have zero dependencies — only Node 24+ built-ins (`node:fs/promises`, `node:crypto`, `node:path`).
- The TS config detection uses regex over `i18n/i18n.config.ts` and `nuxt.config.ts`. It handles the common shapes (`defaultLocale: 'en'`, `locales: ['en', 'fr']` or `locales: [{ code: 'en' }, { code: 'fr' }]`). If detection fails, the script falls back to subfolder names — pass `--source` and `--targets` to override.
- The `.metadata/` folder is internal to the skill. Add it to `.gitignore` only if the project doesn't want incremental tracking shared between contributors. Most projects benefit from committing it.
