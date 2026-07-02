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

function isNavigationFile(relPath: string): boolean {
  return relPath.endsWith('.navigation.yml') || relPath.endsWith('.navigation.yaml');
}

/**
 * Structural sanity checks before recording a translation. A broken target that gets
 * recorded is permanent — extract only re-queues a file when the SOURCE changes — so
 * refuse to record anything that would break at render time. The checks mirror failure
 * modes observed in real translations: content pushed off byte 0 (Nuxt Content then
 * ignores the frontmatter entirely), truncated bodies, and YAML values the translation
 * made unparseable. Heading/image counts are reliable signals because the translation
 * rules require preserving markdown structure (and code blocks byte-for-byte).
 */
function validateTarget(relPath: string, source: string, target: string): string[] {
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
    } else {
      const problems = validateTarget(relPath, sourceContent, targetContent);
      if (problems.length > 0) {
        warnings.push(`${entry.targetPath}: failed validation — not recorded (will re-queue next run): ${problems.join('; ')}`);
        continue;
      }
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
