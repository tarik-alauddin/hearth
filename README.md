# Hearth

Game server hosting on AWS: servers stay off unless someone is playing. Architecture lives in the
"Hearth — Architecture" doc.

## Layout

```
infra/            CDK app (TypeScript): one set of stacks per environment
  bin/hearth.ts   environment stacks; synthesizes dev, stage and prod (-c env=dev for one)
services/         Lambda code (from M2)
agent/            game agent (Go)
packages/shared/  types shared by infra, services and web
```

Stacks are named `hearth-<env>-<Stack>`, e.g. `hearth-dev-Data`, `hearth-prod-GameInfra-us-west-2`.

## Development

Requires Node 24 and pnpm 10; Go 1.27+ for the agent.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm synth                      # every environment; cdk-nag violations fail synth
cd infra && pnpm exec cdk synth -c env=dev
```

The game instance startup script has its own test, which needs Docker (it runs in CI too):

```sh
bash infra/test/user-data/run.sh
```

The agent (Go 1.27+):

```sh
cd agent
go vet ./... && go test ./...
go test -tags harness -timeout 30m ./harness/   # real agent + Minecraft container (Docker)
./build.sh            # linux/arm64 binary at agent/bin/hearth-agent
```

To check a real instance launched from the launch template, follow
[docs/testing/game-instance.md](docs/testing/game-instance.md) (runs in AWS CloudShell).

Servers are managed with the `hearth` CLI (admin API routes, signed with your AWS credentials):

```sh
pnpm hearth create --version 1.21.4
pnpm hearth list | status <id> | start <id> | stop <id>
pnpm --filter @hearth/cli bundle   # cli/dist/hearth.cjs, a single file for CloudShell: node hearth.cjs …
```

To check a server end to end and join it, follow [docs/testing/game-server.md](docs/testing/game-server.md).

## One-time AWS setup

GitHub Actions deploys with the account's existing `github-deploy` role through GitHub OIDC; no AWS keys
are stored. Its trust policy must allow this repo in the `token.actions.githubusercontent.com:sub`
condition. The repo was created after GitHub switched new repos to ID-based subjects, so the entry is
`repo:tarik-alauddin@92332908/hearth@1391534026:*`. Renaming the repo or account changes the subject.

1. CDK bootstrap, once per environment, each with its own qualifier. Run from `infra/` with admin
   credentials for account 138300868928:

   ```sh
   pnpm exec cdk bootstrap aws://138300868928/us-west-2 --qualifier hearthdev --toolkit-stack-name hearth-dev-CDKToolkit
   pnpm exec cdk bootstrap aws://138300868928/us-west-2 --qualifier hearthstg --toolkit-stack-name hearth-stage-CDKToolkit
   pnpm exec cdk bootstrap aws://138300868928/us-west-2 --qualifier hearthprd --toolkit-stack-name hearth-prod-CDKToolkit
   ```

2. In GitHub, create Environments `dev`, `stage` and `prod`, with required reviewers on `prod`.
3. Activate `app` as a cost allocation tag, so the `hearth-monthly` budget (in the `hearth-account` stack)
   counts Hearth's spend. Billing → Cost allocation tags, or:
   `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=app,Status=Active`
   (takes up to 24 hours to apply).
4. After each environment's first deploy, accept the SNS confirmation email for `hearth-<env>-alerts`;
   alarms aren't delivered until then.

## Agent releases

Agents are versioned releases in the `hearth-agent-releases-<account>` bucket. Each environment has
two channels, `canary` and `stable` (SSM `/hearth/<env>/agent/<channel>`); each server follows one
(`hearth set-channel <id> canary|stable`, default stable) and picks up its channel's release on its
next start. A new release that never reaches the API falls back to the previous one automatically.

- **Release:** every merge to `main` that changes `agent/` publishes one, versioned by date and
  commit (`2026.10.01-3f2a9c1`): the *Agent release* workflow runs the harness, uploads it, points
  dev's canary at it, and creates the tag `agent-<version>` with a GitHub Release. Run the workflow
  by hand to cut a release without an agent change. It then prunes old releases
  (`scripts/prune-agent-releases.sh`): every channel's current release and its previous two are
  kept, plus the newest five; pruned ones can be restored from the bucket for 30 days.
- **Promote or roll back:** run the *Promote agent* workflow with an environment, a channel and a
  version from the Releases page (blank stable = that environment's current canary). Prod waits for
  approval. History:
  `aws ssm get-parameter-history --name /hearth/<env>/agent/stable`.
- **A new environment needs a stable release before it can run servers:** new instances download
  their first agent from `stable`. Promote one there once.

## Monitoring

Each environment has a CloudWatch dashboard (`hearth-<env>`) and alarms emailed through
`hearth-<env>-alerts`. The fleet check (stuck, failed and mismatched servers, and Hearth instances no
server points at) runs every 15 minutes in prod; run it anywhere on demand to see its findings:

```sh
pnpm hearth fleet-check [--env dev]
```

It only reports. An untracked instance shows its `serverId` tag (the server it was launched for);
stop or terminate it in the EC2 console if nothing needs it.

## CI/CD

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | Pull request | Lint, typecheck, tests + CDK assertions, synth with cdk-nag, agent build, `cdk diff` against dev posted to the PR |
| `deploy.yml` | Merge to `main` | Synthesize all environments once, deploy that assembly to dev |
