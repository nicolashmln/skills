#!/usr/bin/env node
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

interface Args {
  cwd: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

function parseArgs(): Args {
  const args: Args = { cwd: process.cwd() };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--cwd') args.cwd = process.argv[++i];
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

function getByPath(obj: JsonValue | undefined, dottedPath: string): JsonValue | undefined {
  let cur: JsonValue | undefined = obj;
  for (const part of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as JsonObject)[part];
  }
  return cur;
}

function mergeDeep(target: JsonValue | undefined, source: JsonValue): JsonValue {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return source;
  const base: JsonObject = (target !== null && typeof target === 'object' && !Array.isArray(target))
    ? { ...(target as JsonObject) }
    : {};
  for (const [k, v] of Object.entries(source)) {
    base[k] = mergeDeep(base[k], v);
  }
  return base;
}

// Walks a nested object and yields every dotted-path leaf string.
function* walkLeafPaths(obj: JsonValue, prefix = ''): Generator<{ path: string; value: string }> {
  if (typeof obj === 'string') {
    yield { path: prefix, value: obj };
    return;
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      yield* walkLeafPaths(v, prefix ? `${prefix}.${k}` : k);
    }
  }
}

function findUntranslated(source: JsonValue | undefined, translations: JsonValue, path = ''): string[] {
  const out: string[] = [];
  if (typeof translations === 'string') {
    if (typeof source === 'string' && source === translations) out.push(path);
    return out;
  }
  if (translations !== null && typeof translations === 'object' && !Array.isArray(translations)) {
    const src = (source !== null && typeof source === 'object' && !Array.isArray(source))
      ? (source as JsonObject)
      : {};
    for (const [k, v] of Object.entries(translations)) {
      const p = path ? `${path}.${k}` : k;
      out.push(...findUntranslated(src[k], v, p));
    }
  }
  return out;
}

function countLeaves(v: JsonValue): number {
  if (typeof v === 'string') return 1;
  if (Array.isArray(v)) return 1;
  if (typeof v === 'object' && v !== null) {
    return Object.values(v).reduce((acc: number, x) => acc + countLeaves(x), 0);
  }
  return 1;
}

async function main() {
  const args = parseArgs();
  const localesRoot = await findLocalesRoot(args.cwd);
  const metadataDir = join(localesRoot, '.metadata');
  const pendingPath = join(metadataDir, '.pending.json');

  if (!existsSync(pendingPath)) {
    throw new Error(`No pending translations found at ${pendingPath}. Run extract.ts first.`);
  }

  const pendingText = await readFile(pendingPath, 'utf8');
  const pending = JSON.parse(pendingText) as {
    sourceLang?: string;
    languages?: { [lang: string]: { [file: string]: JsonValue } };
  };

  const sourceLang = pending.sourceLang;
  if (!sourceLang) throw new Error(`Pending file is missing 'sourceLang'.`);
  const sourceDir = join(localesRoot, sourceLang);

  const translatedPath = join(metadataDir, 'translated.json');
  const translatedLangsPath = join(metadataDir, 'translated-langs.json');
  const hashesPath = join(metadataDir, 'hashes.json');
  const translated = new Set(await readArrayMeta(translatedPath));
  const translatedLangs = new Set(await readArrayMeta(translatedLangsPath));
  const hashes: { [k: string]: string } = await readObjectMeta(hashesPath);

  let writtenFiles = 0;
  let writtenKeys = 0;
  const warnings: string[] = [];
  const summary: { lang: string; file: string; keys: number }[] = [];

  for (const [lang, files] of Object.entries(pending.languages ?? {})) {
    const targetDir = join(localesRoot, lang);
    await mkdir(targetDir, { recursive: true });

    for (const [file, translations] of Object.entries(files)) {
      const sourceContent = await readJson(join(sourceDir, file));
      const untranslated = findUntranslated(sourceContent, translations);
      if (untranslated.length > 0) {
        warnings.push(`${lang}/${file}: ${untranslated.length} key(s) match the source verbatim:`);
        for (const k of untranslated.slice(0, 10)) warnings.push(`    - ${k}`);
        if (untranslated.length > 10) warnings.push(`    ... and ${untranslated.length - 10} more`);
      }

      const targetPath = join(targetDir, file);
      await mkdir(dirname(targetPath), { recursive: true });
      const existing = await readJson(targetPath);
      const merged = mergeDeep(existing, translations);
      await writeFile(targetPath, JSON.stringify(merged, null, 2) + '\n');

      // Record every translated leaf path in the shared `translated` set, and
      // store the SHA-1 of the corresponding source value so future extracts can
      // detect when the source text changes.
      for (const { path } of walkLeafPaths(translations)) {
        translated.add(path);
        const sourceVal = getByPath(sourceContent, path);
        if (typeof sourceVal === 'string') {
          hashes[path] = sha1(sourceVal);
        }
      }

      const n = countLeaves(translations);
      writtenFiles++;
      writtenKeys += n;
      summary.push({ lang, file, keys: n });
    }

    translatedLangs.add(lang);
  }

  await writeFile(
    translatedPath,
    JSON.stringify([...translated].sort(), null, 2) + '\n',
  );
  await writeFile(
    translatedLangsPath,
    JSON.stringify([...translatedLangs].sort(), null, 2) + '\n',
  );
  const sortedHashes = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(hashesPath, JSON.stringify(sortedHashes, null, 2) + '\n');
  await unlink(pendingPath);

  // Rough token estimate: the agent reads the pending file as input and rewrites it
  // with translated values, so total content ≈ pending-file size × 2. The conventional
  // ratio of ~4 chars/token gives a usable lower bound; it doesn't include the skill's
  // own prompt overhead, which adds maybe a few hundred tokens.
  const estimatedTokens = Math.round((pendingText.length * 2) / 4);

  console.log(`Wrote ${writtenKeys} key(s) across ${writtenFiles} file(s):`);
  for (const s of summary) console.log(`  ${s.lang}/${s.file}: ${s.keys}`);
  console.log(`Updated ${translatedPath} (${translated.size} keys total).`);
  console.log(`Updated ${translatedLangsPath} ([${[...translatedLangs].sort().join(', ')}]).`);
  console.log(`Updated ${hashesPath} (${Object.keys(hashes).length} hashes total).`);
  console.log(`Removed ${pendingPath}.`);
  console.log(`Estimated tokens used for translation: ~${estimatedTokens.toLocaleString()} (rough; based on translated content, excludes skill prompt overhead).`);

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ${w}`);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
