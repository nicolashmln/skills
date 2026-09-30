#!/usr/bin/env node
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, saveState, sha1, validateTarget } from './shared.ts';

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

  const { state } = await loadState(metadataDir, contentRoot, sourceLang);

  let recordedFiles = 0;
  let totalSourceBytes = 0;
  const warnings: string[] = [];
  const summary: { lang: string; relPath: string }[] = [];

  for (const entry of pending.files ?? []) {
    const { lang, relPath } = entry;
    const sourceAbs = join(args.cwd, entry.sourcePath);
    const targetAbs = join(args.cwd, entry.targetPath);

    if (!existsSync(targetAbs)) {
      // The agent was supposed to write this file but didn't. Don't record it for this
      // language, so the next extract re-queues it.
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

    // Creating the language's key on its first recorded file marks it established; a
    // run where every target was missing leaves a fresh language fresh.
    (state[lang] ??= {})[relPath] = { source: sha1(sourceContent), target: sha1(targetContent) };
    recordedFiles++;
    summary.push({ lang, relPath });
  }

  await saveState(metadataDir, state);
  await unlink(pendingPath);

  // Rough token estimate: the agent reads each source file and writes a translated
  // version of comparable size, so total content ≈ source bytes × 2. The conventional
  // ratio of ~4 chars/token gives a usable lower bound; it doesn't include the skill's
  // own prompt overhead, which adds maybe a few hundred tokens.
  const estimatedTokens = Math.round((totalSourceBytes * 2) / 4);

  console.log(`Recorded ${recordedFiles} translated file(s):`);
  for (const s of summary) console.log(`  ${s.lang}/${s.relPath}`);
  const langs = Object.keys(state).sort();
  const recordCount = langs.reduce((n, lang) => n + Object.keys(state[lang]).length, 0);
  console.log(`Updated ${join(metadataDir, 'translations.json')} (${recordCount} record(s) across [${langs.join(', ')}]).`);
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
