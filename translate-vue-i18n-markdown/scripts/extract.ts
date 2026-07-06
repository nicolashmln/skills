#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

interface Args {
  cwd: string;
  contentDir: string;
  source?: string;
  targets?: string[];
  force: boolean;
  exclude: string[];
}

interface PendingFile {
  lang: string;
  relPath: string;
  sourcePath: string;
  targetPath: string;
  reason: 'fresh-language' | 'new' | 'changed';
}

function parseArgs(): Args {
  const args: Args = { cwd: process.cwd(), contentDir: 'content', force: false, exclude: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--source') args.source = process.argv[++i];
    else if (a === '--targets') args.targets = process.argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--force') args.force = true;
    else if (a === '--cwd') args.cwd = process.argv[++i];
    else if (a === '--content-dir') args.contentDir = process.argv[++i];
    else if (a === '--exclude') args.exclude = process.argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function findContentRoot(cwd: string, contentDir: string): string {
  const p = join(cwd, contentDir);
  if (existsSync(p)) return p;
  throw new Error(`Could not find content folder '${contentDir}' under ${cwd}. Pass --content-dir to override.`);
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

async function detectLanguages(cwd: string, contentRoot: string): Promise<{ source: string; targets: string[] }> {
  for (const c of ['nuxt.config.ts', 'i18n/i18n.config.ts']) {
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

  const entries = await readdir(contentRoot, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  if (folders.length === 0) {
    throw new Error(`No language folders found under ${contentRoot}.`);
  }
  const source = folders.includes('en') ? 'en' : folders[0];
  const targets = folders.filter(f => f !== source);
  console.log(`Detected from folder layout: source=${source}, targets=[${targets.join(', ')}]`);
  return { source, targets };
}

function isNavigationFile(name: string): boolean {
  return name === '.navigation.yml' || name === '.navigation.yaml';
}

async function listContentFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        await walk(full, r);
      } else if (e.name.endsWith('.md') || e.name.endsWith('.markdown')) {
        if (e.name.startsWith('.')) continue;
        out.push(r);
      } else if (isNavigationFile(e.name)) {
        // Nuxt Content directory metadata (title, navigation.icon, …) — the only
        // dotfiles that get translated.
        out.push(r);
      }
    }
  }
  await walk(dir, '');
  return out.sort();
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

  let { source, targets } = await detectLanguages(args.cwd, contentRoot);
  if (args.source) source = args.source;
  if (args.targets) targets = args.targets;

  console.log(`Content root: ${contentRoot}`);
  console.log(`Source: ${source}`);
  console.log(`Targets: [${targets.join(', ')}]`);

  const sourceDir = join(contentRoot, source);
  if (!existsSync(sourceDir)) {
    throw new Error(`Source language folder not found: ${sourceDir}`);
  }

  let sourceFiles = await listContentFiles(sourceDir);
  if (args.exclude.length > 0) {
    // Source-relative path prefixes that stay untranslated (e.g. an English-only
    // internal/ section). Filtering here keeps them out of the pending manifest
    // entirely, instead of re-queueing them on every run for a downstream step to drop.
    const before = sourceFiles.length;
    sourceFiles = sourceFiles.filter(relPath => !args.exclude.some(prefix => relPath.startsWith(prefix)));
    if (before > sourceFiles.length) {
      console.log(`Excluded ${before - sourceFiles.length} file(s) matching [${args.exclude.join(', ')}].`);
    }
  }
  if (sourceFiles.length === 0) {
    console.log('No markdown or .navigation.yml files found in source folder. Nothing to do.');
    return;
  }

  const metadataDir = join(contentRoot, '.metadata');
  await mkdir(metadataDir, { recursive: true });

  const translatedPath = join(metadataDir, 'translated.json');
  const translatedLangsPath = join(metadataDir, 'translated-langs.json');
  const hashesPath = join(metadataDir, 'hashes.json');
  const translated = args.force ? new Set<string>() : new Set(await readArrayMeta(translatedPath));
  const translatedLangs = args.force ? new Set<string>() : new Set(await readArrayMeta(translatedLangsPath));
  const hashes: { [k: string]: string } = args.force ? {} : await readObjectMeta(hashesPath);

  // Reconcile deletions: a path recorded in the metadata whose source file no longer
  // exists on disk is orphaned. Delete its translated copies in every established
  // language and prune it from the metadata, so a removed source page doesn't leave
  // stale translations and stale tracking behind. Existence is checked on disk (not
  // against the exclude-filtered sourceFiles list) so --excluded files, whose source
  // still exists, are never mistaken for deletions. Skipped under --force (no recorded
  // state to diff against) and — because we only reach here when the source folder has
  // files — a misdetected/empty source folder can never trigger a mass deletion.
  const deletedTargets: { lang: string; relPath: string }[] = [];
  const prunedPaths: string[] = [];
  if (!args.force) {
    const recordedPaths = new Set<string>([...translated, ...Object.keys(hashes)]);
    const langsToClean = new Set<string>([...targets, ...translatedLangs]);
    for (const relPath of recordedPaths) {
      if (existsSync(join(sourceDir, relPath))) continue; // source still present — keep.
      for (const lang of langsToClean) {
        const targetAbs = join(contentRoot, lang, relPath);
        if (existsSync(targetAbs)) {
          await unlink(targetAbs);
          deletedTargets.push({ lang, relPath });
        }
      }
      // Prune metadata even when no target file remained on disk, so it never goes stale.
      translated.delete(relPath);
      delete hashes[relPath];
      prunedPaths.push(relPath);
    }
  }

  // Hash every source file once (whole-file content is the translation unit).
  const sourceHashes: { [relPath: string]: string } = {};
  for (const relPath of sourceFiles) {
    sourceHashes[relPath] = sha1(await readFile(join(sourceDir, relPath), 'utf8'));
  }

  const files: PendingFile[] = [];
  let backfilled = 0;

  for (const lang of targets) {
    const isFreshLang = !translatedLangs.has(lang);

    for (const relPath of sourceFiles) {
      const sourceHash = sourceHashes[relPath];
      let reason: PendingFile['reason'] | null = null;

      if (isFreshLang) {
        // Fresh language: translate every file regardless of metadata. write.ts
        // records the source hash when the translation lands.
        reason = 'fresh-language';
      } else if (!translated.has(relPath)) {
        // Brand-new source file.
        reason = 'new';
      } else if (!(relPath in hashes)) {
        // File was translated by a previous version of the skill that didn't track
        // hashes. Backfill silently — assume the existing translation matches the
        // current source.
        hashes[relPath] = sourceHash;
        backfilled++;
      } else if (hashes[relPath] !== sourceHash) {
        // Source file changed since last translation — re-queue.
        reason = 'changed';
      }
      // else: already translated and unchanged. Skip.

      if (reason) {
        files.push({
          lang,
          relPath,
          sourcePath: join(args.contentDir, source, relPath),
          targetPath: join(args.contentDir, lang, relPath),
          reason,
        });
      }
    }
  }

  const pending = {
    sourceLang: source,
    extractedAt: new Date().toISOString(),
    contentRoot: args.contentDir,
    files,
  };

  const pendingPath = join(metadataDir, '.pending.json');
  if (files.length > 0) {
    await writeFile(pendingPath, JSON.stringify(pending, null, 2) + '\n');
  } else if (existsSync(pendingPath)) {
    // Nothing to translate — clear any stale pending file from a previous run so
    // write.ts can't accidentally process empty leftovers.
    await unlink(pendingPath);
  }

  // Backfilled hashes and pruned deletions need to be persisted even when nothing was
  // queued, so that the next run sees up-to-date metadata. write.ts will overwrite these
  // files with its own additions for any files translated this round; it reads the
  // already-persisted (pruned/backfilled) state first, so there's no conflict.
  if (backfilled > 0 || prunedPaths.length > 0 || args.force) {
    const sortedHashes = Object.fromEntries(
      Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(hashesPath, JSON.stringify(sortedHashes, null, 2) + '\n');
  }
  if (prunedPaths.length > 0) {
    await writeFile(translatedPath, JSON.stringify([...translated].sort(), null, 2) + '\n');
  }

  console.log();
  if (deletedTargets.length > 0) {
    console.log(`Deleted ${deletedTargets.length} orphaned translation(s) whose source was removed:`);
    for (const d of deletedTargets) console.log(`  ${d.lang}/${d.relPath}`);
  }
  if (prunedPaths.length > 0) {
    console.log(`Pruned ${prunedPaths.length} path(s) from metadata.`);
  }
  if (files.length > 0) {
    console.log(`Wrote ${pendingPath}`);
  }
  console.log(`Total files to translate: ${files.length}`);
  if (backfilled > 0) {
    console.log(`Backfilled ${backfilled} hash(es) for previously translated files (no re-translation queued).`);
  }
  if (files.length === 0) {
    console.log('Nothing to translate.');
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
