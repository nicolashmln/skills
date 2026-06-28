#!/usr/bin/env node
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface Args {
  cwd: string;
  contentDir: string;
}

interface PendingFile {
  lang: string;
  relPath: string;
  sourcePath: string;
  targetPath: string;
  reason?: string;
}

function parseArgs(): Args {
  const args: Args = { cwd: process.cwd(), contentDir: 'content' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--cwd') args.cwd = process.argv[++i];
    else if (a === '--content-dir') args.contentDir = process.argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function findContentRoot(cwd: string, contentDir: string): string {
  const p = join(cwd, contentDir);
  if (existsSync(p)) return p;
  throw new Error(`Could not find content folder '${contentDir}' under ${cwd}. Pass --content-dir to override.`);
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

async function main() {
  const args = parseArgs();
  const contentRoot = findContentRoot(args.cwd, args.contentDir);
  const metadataDir = join(contentRoot, '.metadata');
  const pendingPath = join(metadataDir, '.pending.json');

  if (!existsSync(pendingPath)) {
    throw new Error(`No pending translations found at ${pendingPath}. Run extract.ts first.`);
  }

  const pendingText = await readFile(pendingPath, 'utf8');
  const pending = JSON.parse(pendingText) as {
    sourceLang?: string;
    files?: PendingFile[];
  };

  const sourceLang = pending.sourceLang;
  if (!sourceLang) throw new Error(`Pending file is missing 'sourceLang'.`);

  const translatedPath = join(metadataDir, 'translated.json');
  const translatedLangsPath = join(metadataDir, 'translated-langs.json');
  const hashesPath = join(metadataDir, 'hashes.json');
  const translated = new Set(await readArrayMeta(translatedPath));
  const translatedLangs = new Set(await readArrayMeta(translatedLangsPath));
  const hashes: { [k: string]: string } = await readObjectMeta(hashesPath);

  let recordedFiles = 0;
  let totalSourceBytes = 0;
  const warnings: string[] = [];
  const summary: { lang: string; relPath: string }[] = [];
  const langsWithWrites = new Set<string>();

  for (const entry of pending.files ?? []) {
    const { lang, relPath } = entry;
    const sourceAbs = join(args.cwd, entry.sourcePath);
    const targetAbs = join(args.cwd, entry.targetPath);

    if (!existsSync(targetAbs)) {
      // The agent was supposed to write this file but didn't. Don't record it, so
      // the next extract re-queues it.
      warnings.push(`${entry.targetPath}: target file missing — not recorded (will re-queue next run).`);
      continue;
    }

    const sourceContent = await readFile(sourceAbs, 'utf8');
    const targetContent = await readFile(targetAbs, 'utf8');
    totalSourceBytes += sourceContent.length;

    if (targetContent === sourceContent) {
      // Byte-identical output usually means the file wasn't actually translated.
      // Sometimes legitimate (e.g. a code-only snippet page) — record it anyway,
      // mirroring the JSON skill, but surface a warning.
      warnings.push(`${entry.targetPath}: target is byte-identical to the source (possible missed translation).`);
    }

    translated.add(relPath);
    hashes[relPath] = sha1(sourceContent);
    langsWithWrites.add(lang);
    recordedFiles++;
    summary.push({ lang, relPath });
  }

  // Only mark a language fully processed once it has at least one recorded file,
  // so a run where every target was missing doesn't falsely flip a fresh language.
  for (const lang of langsWithWrites) translatedLangs.add(lang);

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

  // Rough token estimate: the agent reads each source file and writes a translated
  // version of comparable size, so total content ≈ source bytes × 2. The conventional
  // ratio of ~4 chars/token gives a usable lower bound; it doesn't include the skill's
  // own prompt overhead, which adds maybe a few hundred tokens.
  const estimatedTokens = Math.round((totalSourceBytes * 2) / 4);

  console.log(`Recorded ${recordedFiles} translated file(s):`);
  for (const s of summary) console.log(`  ${s.lang}/${s.relPath}`);
  console.log(`Updated ${translatedPath} (${translated.size} files total).`);
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
