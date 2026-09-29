import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSourceHash } from '../lib/agent-asset.js';

function agentDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hash-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const SOURCE = { 'go.mod': 'module x\n', 'cmd/main.go': 'package main\n\nfunc main() {}\n' };

describe('agentSourceHash', () => {
  it('is the same for Windows (CRLF) and Linux (LF) checkouts', () => {
    const crlf = Object.fromEntries(Object.entries(SOURCE).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
    expect(agentSourceHash(agentDir(crlf))).toBe(agentSourceHash(agentDir(SOURCE)));
  });

  it('ignores tests and build output', () => {
    const withExtras = { ...SOURCE, 'cmd/main_test.go': 'package main\n', 'bin/hearth-agent': 'binary' };
    expect(agentSourceHash(agentDir(withExtras))).toBe(agentSourceHash(agentDir(SOURCE)));
  });

  it('changes when the source changes', () => {
    const changed = { ...SOURCE, 'cmd/main.go': 'package main\n\nfunc main() { println() }\n' };
    expect(agentSourceHash(agentDir(changed))).not.toBe(agentSourceHash(agentDir(SOURCE)));
  });

  it('hashes the real agent', () => {
    expect(agentSourceHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
