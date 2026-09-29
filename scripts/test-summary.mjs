// Writes one GitHub Actions job summary from Vitest's JSON report, naming every failing test.
// Usage: node scripts/test-summary.mjs [test-results.json]   (writes to $GITHUB_STEP_SUMMARY, else stdout)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';

const resultsFile = process.argv[2] ?? 'test-results.json';
const MAX_LISTED = 50;
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.SUMMARY_SHA || process.env.GITHUB_SHA;
const root = process.env.GITHUB_WORKSPACE ?? process.cwd();

function write(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
}

const plain = (text) => stripVTControlCharacters(text ?? '');
const cell = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function where(path, line) {
  const file = relative(root, path).replaceAll('\\', '/');
  const label = `${file}${line ? `:${line}` : ''}`;
  return repo && sha ? `[${label}](https://github.com/${repo}/blob/${sha}/${file}${line ? `#L${line}` : ''})` : `\`${label}\``;
}

if (!existsSync(resultsFile)) {
  write('## Tests\n\n❌ No results: the run crashed before reporting. See the step log.\n');
  process.exit(0);
}

const report = JSON.parse(readFileSync(resultsFile, 'utf8'));
const failures = [];
for (const file of report.testResults ?? []) {
  const failed = (file.assertionResults ?? []).filter((t) => t.status === 'failed');
  if (file.status === 'failed' && failed.length === 0) {
    failures.push({ name: 'File failed to run', where: where(file.name), message: plain(file.message) });
  }
  for (const test of failed) {
    failures.push({
      name: test.fullName ?? test.title,
      where: where(file.name, test.location?.line),
      message: plain((test.failureMessages ?? []).join('\n')),
    });
  }
}

const passed = report.numPassedTests ?? 0;
if (failures.length === 0) {
  write(`## Tests\n\n✅ All ${passed} tests passed.\n`);
} else {
  // GitHub drops a step summary over 1 MB, so only the first MAX_LISTED failures are shown.
  const listed = failures.slice(0, MAX_LISTED);
  let md = `## Tests\n\n❌ **${failures.length} failed**, ${passed} passed\n\n| Test | Where | Error |\n| --- | --- | --- |\n`;
  for (const f of listed) {
    const first = f.message.split('\n').find((l) => l.trim()) ?? '';
    md += `| ${cell(f.name)} | ${f.where} | ${cell(first.slice(0, 160))} |\n`;
  }
  if (failures.length > listed.length) {
    md += `\n…and ${failures.length - listed.length} more; see the step log and the annotations.\n`;
  }
  md += '\n';
  for (const f of listed) {
    // Our frames only: Vitest's own stack frames add nothing.
    const detail = f.message
      .split('\n')
      .filter((line) => !line.includes('node_modules'))
      .slice(0, 40)
      .join('\n');
    md += `<details><summary>${f.name.replace(/</g, '&lt;')}</summary>\n\n\`\`\`\n${detail}\n\`\`\`\n\n</details>\n`;
  }
  write(md);
}
