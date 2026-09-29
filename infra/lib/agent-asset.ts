import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundlingOutput, DockerImage } from 'aws-cdk-lib';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

const AGENT_DIR = fileURLToPath(new URL('../../agent', import.meta.url));
const GO_IMAGE = 'public.ecr.aws/docker/library/golang:1.27';

/**
 * The game agent binary (linux/arm64), built during synth and uploaded to the CDK asset bucket.
 * Uses the local Go toolchain, or a golang container when Go isn't installed.
 *
 * The asset hash and the agent's version both come from the agent's source, so an unchanged agent
 * keeps its version and isn't rebuilt, re-uploaded or given a new launch template version.
 * M4 replaces this with versioned releases and SSM channels.
 */
export function agentAsset(scope: Construct, id: string): Asset {
  const sourceHash = agentSourceHash();
  const ldflags = `-s -w -X main.version=${sourceHash.slice(0, 12)}`;
  return new Asset(scope, id, {
    path: AGENT_DIR,
    assetHash: sourceHash,
    bundling: {
      image: DockerImage.fromRegistry(GO_IMAGE),
      environment: { GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '0' },
      command: ['go', 'build', '-trimpath', '-ldflags', ldflags, '-o', '/asset-output/hearth-agent', './cmd/hearth-agent'],
      outputType: BundlingOutput.SINGLE_FILE,
      local: {
        tryBundle(outputDir) {
          try {
            execFileSync('go', ['version'], { stdio: 'ignore' });
          } catch {
            return false; // no Go: fall back to the container
          }
          execFileSync(
            'go',
            ['build', '-trimpath', '-ldflags', ldflags, '-o', join(outputDir, 'hearth-agent'), './cmd/hearth-agent'],
            {
              cwd: AGENT_DIR,
              env: { ...process.env, GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '0' },
              stdio: ['ignore', 'inherit', 'inherit'],
            },
          );
          return true;
        },
      },
    },
  });
}

/**
 * SHA-256 over the agent's source files (not tests or build output), with line endings
 * normalized so a Windows checkout and CI's Linux checkout agree.
 */
export function agentSourceHash(dir = AGENT_DIR): string {
  const hash = createHash('sha256');
  for (const file of sourceFiles(dir)) {
    const path = relative(dir, file).split(sep).join('/');
    const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    hash.update(`${path}\0${content}\0`);
  }
  return hash.digest('hex');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'bin' ? [] : sourceFiles(path);
      return entry.name.endsWith('_test.go') ? [] : [path];
    })
    .sort();
}
