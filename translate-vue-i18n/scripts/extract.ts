#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface Args {
  cwd: string;
  source?: string;
  targets?: string[];
  force: boolean;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

function parseArgs(): Args {
  const args: Args = { cwd: process.cwd(), force: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--source') args.source = process.argv[++i];
    else if (a === '--targets') args.targets = process.argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--force') args.force = true;
    else if (a === '--cwd') args.cwd = process.argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function findLocalesRoot(cwd: string): Promise<string> {
  for (const c of ['i18n/locales', 'locales']) {
    const p = join(cwd, c);
    if (existsSync(p)) return p;
  }
  throw new Error(`Could not find locales folder. Looked for 'i18n/locales' and 'locales' under ${cwd}.`);
}

function parseConfigFile(text: string): { source?: string; targets?: string[] } {
  const out: { source?: string; targets?: string[] } = {};

  const defaultLocaleMatch = text.match(/defaultLocale\s*:\s*['"]([\w-]+)['"]/);
  if (defaultLocaleMatch) out.source = defaultLocaleMatch[1];

  if (!out.source) {
    const localeMatch = text.match(/\blocale\s*:\s*['"]([\w-]+)['"]/);
    if (localeMatch) out.source = localeMatch[1];
  }

  const localesStartMatch = text.match(/\blocales\s*:\s*\[/);
  if (localesStartMatch && localesStartMatch.index !== undefined) {
    const start = localesStartMatch.index + localesStartMatch[0].length;
    const end = findMatchingBracket(text, start - 1);
    if (end > start) {
      const inner = text.slice(start, end);
      const codes: string[] = [];
      if (/\bcode\s*:/.test(inner)) {
        for (const m of inner.matchAll(/\bcode\s*:\s*['"]([\w-]+)['"]/g)) codes.push(m[1]);
      } else {
        for (const m of inner.matchAll(/['"]([\w-]+)['"]/g)) codes.push(m[1]);
      }
      if (codes.length > 0) out.targets = codes;
    }
  }

  return out;
}

function findMatchingBracket(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  let inString: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === inString) inString = null;
    } else {
      if (c === '"' || c === "'" || c === '`') inString = c;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return i; }
    }
    i++;
  }
  return -1;
}

async function detectLanguages(cwd: string, localesRoot: string): Promise<{ source: string; targets: string[] }> {
  for (const c of ['i18n/i18n.config.ts', 'nuxt.config.ts']) {
    const p = join(cwd, c);
    if (!existsSync(p)) continue;
    const text = await readFile(p, 'utf8');
    const parsed = parseConfigFile(text);
    if (parsed.source && parsed.targets && parsed.targets.length > 0) {
      const source = parsed.source;
      const targets = parsed.targets.filter(t => t !== source);
      console.log(`Detected from ${c}: source=${source}, targets=[${targets.join(', ')}]`);
      return { source, targets };
    }
  }

  const entries = await readdir(localesRoot, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  if (folders.length === 0) {
    throw new Error(`No language folders found under ${localesRoot}.`);
  }
  const source = folders.includes('en') ? 'en' : folders[0];
  const targets = folders.filter(f => f !== source);
  console.log(`Detected from folder layout: source=${source}, targets=[${targets.join(', ')}]`);
  return { source, targets };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, r);
      else if (e.name.endsWith('.json')) out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

async function readJson(path: string): Promise<JsonObject> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function readArrayMeta(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  if (!text.trim()) return [];
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : [];
}

async function readObjectMeta(path: string): Promise<{ [k: string]: string }> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  if (!text.trim()) return {};
  const v = JSON.parse(text);
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

// Walks the source tree and returns a flat map of dotted-path => leaf value (strings only).
function flattenStrings(obj: JsonValue, prefix = '', out: { [k: string]: string } = {}): { [k: string]: string } {
  if (typeof obj === 'string') {
    out[prefix] = obj;
    return out;
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      flattenStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

// Given a flat map of dotted-path => value, rebuild a nested object that mirrors
// the source structure for those paths.
function unflattenPaths(flat: { [k: string]: string }): JsonObject {
  const out: JsonObject = {};
  for (const [path, val] of Object.entries(flat)) {
    const parts = path.split('.');
    let cur: JsonObject = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) {
        cur[p] = {};
      }
      cur = cur[p] as JsonObject;
    }
    cur[parts[parts.length - 1]] = val;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const localesRoot = await findLocalesRoot(args.cwd);

  let { source, targets } = await detectLanguages(args.cwd, localesRoot);
  if (args.source) source = args.source;
  if (args.targets) targets = args.targets;

  console.log(`Locales root: ${localesRoot}`);
  console.log(`Source: ${source}`);
  console.log(`Targets: [${targets.join(', ')}]`);

  const sourceDir = join(localesRoot, source);
  if (!existsSync(sourceDir)) {
    throw new Error(`Source language folder not found: ${sourceDir}`);
  }

  const sourceFiles = await listJsonFiles(sourceDir);
  if (sourceFiles.length === 0) {
    console.log('No JSON files found in source folder. Nothing to do.');
    return;
  }

  const metadataDir = join(localesRoot, '.metadata');
  await mkdir(metadataDir, { recursive: true });

  const translatedPath = join(metadataDir, 'translated.json');
  const translatedLangsPath = join(metadataDir, 'translated-langs.json');
  const hashesPath = join(metadataDir, 'hashes.json');
  const translated = args.force ? new Set<string>() : new Set(await readArrayMeta(translatedPath));
  const translatedLangs = args.force ? new Set<string>() : new Set(await readArrayMeta(translatedLangsPath));
  const hashes: { [k: string]: string } = args.force ? {} : await readObjectMeta(hashesPath);

  // Build a single flat map of {dotted-path: source-value} across all source files,
  // grouped by file so we can reconstruct nested per-file pending output.
  const sourceByFile: { [file: string]: { [path: string]: string } } = {};
  for (const file of sourceFiles) {
    sourceByFile[file] = flattenStrings(await readJson(join(sourceDir, file)));
  }

  const pending: { sourceLang: string; extractedAt: string; languages: { [lang: string]: { [file: string]: JsonObject } } } = {
    sourceLang: source,
    extractedAt: new Date().toISOString(),
    languages: {},
  };

  let totalKeys = 0;
  let backfilled = 0;

  for (const lang of targets) {
    const isFreshLang = !translatedLangs.has(lang);
    const langPending: { [file: string]: JsonObject } = {};

    for (const [file, flatSource] of Object.entries(sourceByFile)) {
      const filePending: { [path: string]: string } = {};
      for (const [path, val] of Object.entries(flatSource)) {
        const sourceHash = sha1(val);
        if (isFreshLang) {
          // Fresh language: translate everything regardless of metadata. write.ts
          // will record the source hash when the translation lands.
          filePending[path] = val;
        } else if (!translated.has(path)) {
          // Brand-new key.
          filePending[path] = val;
        } else if (!(path in hashes)) {
          // Key was translated by a previous version of the skill that didn't track
          // hashes. Backfill silently — assume the existing translation matches the
          // current source.
          hashes[path] = sourceHash;
          backfilled++;
        } else if (hashes[path] !== sourceHash) {
          // Source value changed since last translation — re-queue.
          filePending[path] = val;
        }
        // else: already translated and unchanged. Skip.
      }
      if (Object.keys(filePending).length > 0) {
        langPending[file] = unflattenPaths(filePending);
        totalKeys += Object.keys(filePending).length;
      }
    }

    if (Object.keys(langPending).length > 0) {
      pending.languages[lang] = langPending;
    }
  }

  const pendingPath = join(metadataDir, '.pending.json');
  await writeFile(pendingPath, JSON.stringify(pending, null, 2) + '\n');

  // Backfilled hashes need to be persisted even when nothing was queued, so that
  // the next run sees up-to-date metadata. write.ts will overwrite this file with
  // its own additions for any keys that get translated this round; backfills are
  // disjoint from those (they come from already-translated keys), so no conflict.
  if (backfilled > 0 || args.force) {
    const sortedHashes = Object.fromEntries(
      Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(hashesPath, JSON.stringify(sortedHashes, null, 2) + '\n');
  }

  console.log(`\nWrote ${pendingPath}`);
  console.log(`Total keys to translate: ${totalKeys}`);
  if (backfilled > 0) {
    console.log(`Backfilled ${backfilled} hash(es) for previously translated keys (no re-translation queued).`);
  }
  if (totalKeys === 0) {
    console.log('Nothing to translate.');
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
