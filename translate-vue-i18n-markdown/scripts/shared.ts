import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** SHA-1s of a source file and of its translation, as of when the translation was recorded. */
export interface TranslationRecord {
  source: string;
  target: string;
}

/**
 * lang → source-relative path → record. Tracked per language so a translation that fails
 * or goes missing in one language is re-queued even when other languages recorded the same
 * path. A language is established once it has a key; an absent key means a fresh language.
 */
export type TranslationState = { [lang: string]: { [relPath: string]: TranslationRecord } };

const STATE_FILE = 'translations.json';
// Shared (not per-language) metadata written by earlier versions of the skill.
const LEGACY_FILES = ['translated.json', 'translated-langs.json', 'hashes.json', 'target-hashes.json'];

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, 'utf8');
  return text.trim() ? JSON.parse(text) : undefined;
}

function isObject(v: unknown): v is { [k: string]: unknown } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reads translations.json, or builds it from the legacy files: every language in
 * translated-langs.json gets a record for each translated.json path whose target exists,
 * with the stored source hash (or the current one, for files that predate hash tracking)
 * and the stored target hash (or the target's current one). `migrated` is the number of
 * records built that way, or null when there was nothing to migrate.
 */
export async function loadState(
  metadataDir: string,
  contentRoot: string,
  sourceLang: string,
): Promise<{ state: TranslationState; migrated: number | null }> {
  const current = await readJson(join(metadataDir, STATE_FILE));
  if (current !== undefined || !LEGACY_FILES.some(f => existsSync(join(metadataDir, f)))) {
    return { state: isObject(current) ? current as TranslationState : {}, migrated: null };
  }

  const asArray = (v: unknown): string[] => Array.isArray(v) ? v : [];
  const translated = asArray(await readJson(join(metadataDir, 'translated.json')));
  const langs = asArray(await readJson(join(metadataDir, 'translated-langs.json')));
  const legacyHashes = await readJson(join(metadataDir, 'hashes.json'));
  const hashes = isObject(legacyHashes) ? legacyHashes as { [relPath: string]: string } : {};
  const legacyTargetHashes = await readJson(join(metadataDir, 'target-hashes.json'));
  const targetHashes = isObject(legacyTargetHashes)
    ? legacyTargetHashes as { [lang: string]: { [relPath: string]: string } }
    : {};

  const state: TranslationState = {};
  let migrated = 0;
  for (const lang of langs) {
    state[lang] = {};
    for (const relPath of translated) {
      const targetAbs = join(contentRoot, lang, relPath);
      if (!existsSync(targetAbs)) continue;
      const sourceAbs = join(contentRoot, sourceLang, relPath);
      // A path whose source is gone still gets a record, so extract can clean up its
      // orphaned translations.
      const source = hashes[relPath]
        ?? (existsSync(sourceAbs) ? sha1(await readFile(sourceAbs, 'utf8')) : '');
      const target = targetHashes[lang]?.[relPath] ?? sha1(await readFile(targetAbs, 'utf8'));
      state[lang][relPath] = { source, target };
      migrated++;
    }
  }
  return { state, migrated };
}

/** Writes translations.json with sorted keys and removes any legacy metadata files. */
export async function saveState(metadataDir: string, state: TranslationState): Promise<void> {
  const sortKeys = <T>(obj: { [k: string]: T }) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  const sorted = sortKeys(Object.fromEntries(
    Object.entries(state).map(([lang, records]) => [lang, sortKeys(records)]),
  ));
  await writeFile(join(metadataDir, STATE_FILE), JSON.stringify(sorted, null, 2) + '\n');
  for (const f of LEGACY_FILES) {
    if (existsSync(join(metadataDir, f))) await unlink(join(metadataDir, f));
  }
}

export function isNavigationFile(relPath: string): boolean {
  return relPath.endsWith('.navigation.yml') || relPath.endsWith('.navigation.yaml');
}

/**
 * Structural sanity checks before recording a translation — whether write.ts is recording
 * one the agent just wrote, or extract.ts is adopting one that was updated outside the
 * skill. A broken target that gets recorded is permanent — extract only re-queues a file
 * when the SOURCE changes — so refuse to record anything that would break at render time.
 * The checks mirror failure modes observed in real translations: content pushed off byte 0
 * (Nuxt Content then ignores the frontmatter entirely), truncated bodies, and YAML values
 * the translation made unparseable. Heading/image counts are reliable signals because the
 * translation rules require preserving markdown structure (and code blocks byte-for-byte).
 */
export function validateTarget(relPath: string, source: string, target: string): string[] {
  const problems: string[] = [];
  const fmMatch = target.match(/^---\n([\s\S]*?)\n---(\r?\n|$)/);
  if (!isNavigationFile(relPath)) {
    if (source.trimStart().startsWith('---')) {
      if (!target.startsWith('---')) problems.push('frontmatter fence missing at byte 0');
      else if (!fmMatch) problems.push('frontmatter fence never closes');
    }
    const sourceLines = source.split('\n').length;
    const targetLines = target.split('\n').length;
    if (sourceLines > 10 && targetLines < sourceLines * 0.5) {
      problems.push(`suspiciously short (${targetLines} lines vs ${sourceLines} in source)`);
    }
    const headings = (t: string) => (t.match(/^#{1,6}\s/gm) ?? []).length;
    const images = (t: string) => (t.match(/!\[/g) ?? []).length;
    if (headings(target) < headings(source)) {
      problems.push(`fewer headings than source (${headings(target)} vs ${headings(source)})`);
    }
    if (images(target) < images(source)) {
      problems.push(`fewer images than source (${images(target)} vs ${images(source)})`);
    }
  } else {
    const keys = (t: string) => (t.match(/^[\w.-]+:/gm) ?? []).length;
    if (keys(target) < keys(source)) {
      problems.push(`fewer top-level YAML keys than source (${keys(target)} vs ${keys(source)})`);
    }
  }
  // YAML the translation can break: an apostrophe inside a single-quoted scalar must be
  // doubled ('Qu''est-ce…'), and a plain (unquoted) scalar can't contain ": " (happens
  // when a source dash gets translated as a colon).
  const yamlPart = isNavigationFile(relPath) ? target : fmMatch?.[1];
  for (const line of yamlPart?.split('\n') ?? []) {
    const quoted = line.match(/^\s*[\w.-]+:\s*'(.*)'\s*$/);
    if (quoted && /(^|[^'])'([^']|$)/.test(quoted[1])) {
      problems.push(`unescaped single quote in YAML value: ${line.trim()}`);
    }
    const plain = line.match(/^\s*[\w.-]+:\s+([^'"|>[{&*!#-].*)$/);
    if (plain && plain[1].includes(': ')) {
      problems.push(`unquoted colon in YAML value: ${line.trim()}`);
    }
  }
  return problems;
}
