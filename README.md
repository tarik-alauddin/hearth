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

Requires Node 24 and pnpm 10; Go 1.25+ for the agent.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm synth                      # every environment; cdk-nag violations fail synth; builds the agent (needs Go, or Docker)
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
./build.sh            # linux/arm64 binary at agent/bin/hearth-agent
```

To check a real instance launched from the launch template, follow
[docs/testing/game-instance.md](docs/testing/game-instance.md) (runs in AWS CloudShell).

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

## CI/CD

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | Pull request | Lint, typecheck, tests + CDK assertions, synth with cdk-nag, agent build, `cdk diff` against dev posted to the PR |
| `deploy.yml` | Merge to `main` | Synthesize all environments once, deploy that assembly to dev |
