import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundlingOutput, DockerImage } from 'aws-cdk-lib';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

const AGENT_DIR = fileURLToPath(new URL('../../agent', import.meta.url));
const GO_IMAGE = 'public.ecr.aws/docker/library/golang:1.27';

/**
 * The game agent binary (linux/arm64), built during synth and uploaded to the CDK asset bucket.
 * Uses the local Go toolchain, or a golang container when Go isn't installed. The asset hash
 * comes from the agent's source, so an unchanged agent isn't rebuilt or re-uploaded.
 * M4 replaces this with versioned releases and SSM channels.
 */
export function agentAsset(scope: Construct, id: string): Asset {
  const version = agentVersion();
  const ldflags = `-s -w -X main.version=${version}`;
  return new Asset(scope, id, {
    path: AGENT_DIR,
    exclude: ['bin', '**/*_test.go'],
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

/** HEARTH_AGENT_VERSION when set (CI), else the git commit. */
function agentVersion(): string {
  if (process.env.HEARTH_AGENT_VERSION) return process.env.HEARTH_AGENT_VERSION;
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: AGENT_DIR, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}
