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
