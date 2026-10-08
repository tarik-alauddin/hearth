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

Requires Node 24 and pnpm 12 (pinned in `package.json`; pnpm switches to it automatically); Go 1.27+ for the agent.

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

2. In GitHub, create Environments `dev`, `stage` and `prod`. On `stage` and `prod`, limit deployments
   to branch `main`; optionally, required reviewers on `prod`. Optionally, a tag ruleset so `v*` and
   `agent-*` tags can't be moved or deleted.
3. Activate `app` as a cost allocation tag, so the `hearth-monthly` budget (in the `hearth-account` stack)
   counts Hearth's spend. Billing → Cost allocation tags, or:
   `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=app,Status=Active`
   (takes up to 24 hours to apply).
4. After each environment's first deploy, accept the SNS confirmation email for `hearth-<env>-alerts`;
   alarms aren't delivered until then.
5. Create your own sign-in user in each environment's user pool, in the `admin` group:
   [docs/testing/sign-in.md](docs/testing/sign-in.md), steps 1–2. There is no self sign-up; password
   users are only the ones you create, with MFA.

## Sign-in

Each environment has a Cognito user pool (AuthStack) with managed login pages on its Cognito domain
(`hearth-<env>-<account>`; a custom domain later). Clients find the pool, domain and client IDs in
one SSM parameter, `/hearth/<env>/auth`. The CLI signs in through a loopback callback
(`http://localhost:8976/callback`); the web client exists where the environment lists web origins
(dev: Vite on `http://localhost:5173`). Members of the `admin` group are Hearth admins.

## Agents

Agent builds are versioned binaries in the `hearth-agent-releases-<account>` bucket, versioned by
date and commit (`2026.10.07-3f2a9c1`). Each environment has two channels, `canary` and `stable`
(SSM `/hearth/<env>/agent/<channel>`); each server follows one (`hearth set-channel <id>
canary|stable`, default stable) and picks up its channel's agent on its next start. A new agent that
never reaches the API falls back to the previous one automatically.

- **Build:** a merge to `main` that changed `agent/` since the newest build makes a new one (the
  *Deploy* workflow: harness, upload, dev's canary). Every release carries an agent (see
  [Releases](#releases)); promoting a release puts its agent on that env's canary.
- **Canary → stable:** run *Promote* with "agent canary → stable" and an env. "roll back" returns
  stable to its previous agent; "specific version", to any agent that env has run.
- **Pruning** (`scripts/prune-agent-releases.sh`, after each build): every channel's current agent
  and its previous two are kept, plus the newest five; pruned ones can be restored from the bucket
  for 30 days.
- **A new environment needs a stable agent before it can run servers:** new instances download
  their first agent from `stable`. Promote a release there, then canary → stable.

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
| `deploy.yml` | Merge to `main`; by hand, to try a branch on dev | Synthesize all environments once, deploy that assembly to dev, build the agent if it changed, publish a release |
| `promote.yml` | By hand | *Promote*: a release to an env, or an env's agent from canary to stable |

The deploy steps themselves are the `.github/actions/deploy` action (deploy one environment from
the run's assembly, record it in `/hearth/<env>/release`).

### Releases

Every merge to `main` deploys dev and publishes one pre-release `v<date>-<sha7>` (e.g.
`v2026.10.07-3f2a9c1`) with `cloud-assembly.zip` (what dev deployed) and `release.json` (its agent:
new if `agent/` changed, else the newest build). To ship it, run **Promote** (which: "promote"):

1. "release", env `stage` (the newest release). Deploys stage and puts the release's agent on
   stage's canary. Try it.
2. "agent canary → stable", env `stage`, when the agent looks good (skip if it didn't change).
3. "release", env `prod` (what stage runs). Prod only takes a release stage has run, deploys the
   same assembly (never a rebuild), and marks it **Latest** on the Releases page.
4. "agent canary → stable", env `prod`.

Dev's agent goes the same way: a build lands on dev's canary; "agent canary → stable", env `dev`.
Roll back with which "roll back" (the env's previous release, or stable's previous agent), or
"specific version" and a version typed from the Releases page. What runs where:
`aws ssm get-parameter-history --name /hearth/<env>/release` (and `…/agent/canary`, `…/agent/stable`).
