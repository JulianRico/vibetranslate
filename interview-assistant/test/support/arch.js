import fs from 'node:fs';
import path from 'node:path';

/** All .js files under `dir` (recursive). Missing directory → []. */
export function listJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Module specifiers imported by a file (static, re-export and dynamic imports). */
export function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * Imports inside `dir` that do not resolve inside one of `allowedDirs`.
 * Bare specifiers (`node:fs`, packages) count as violations unless `allowBare` is true.
 */
export function findViolations(dir, allowedDirs, { allowBare = false } = {}) {
  const bad = [];
  for (const file of listJs(dir)) {
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) {
        if (!allowBare) bad.push(`${path.relative(process.cwd(), file)} → ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      const ok = allowedDirs.some((d) => target === d || target.startsWith(d + path.sep));
      if (!ok) bad.push(`${path.relative(process.cwd(), file)} → ${spec}`);
    }
  }
  return bad;
}

/** Files in `dir` that mention any of the given global names as a whole word. */
export function findGlobals(dir, names) {
  const re = new RegExp(`\\b(?:${names.join('|')})\\b`);
  const bad = [];
  for (const file of listJs(dir)) {
    const stripped = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const m = re.exec(stripped);
    if (m) bad.push(`${path.relative(process.cwd(), file)} → ${m[0]}`);
  }
  return bad;
}
