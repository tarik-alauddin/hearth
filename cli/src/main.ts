// hearth: create and manage game servers through the Hearth API's admin routes.
// Signs requests with your AWS credentials (profile, environment or CloudShell).
import { parseArgs } from 'node:util';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { ApiError, apiClient, findApiUrl } from './client.js';
import { CommandError, commands } from './commands.js';

const USAGE = `Usage: hearth <command> [options]

  create --version <v> [--game minecraft-java] [--game-region <region>]
  list
  status <serverId>
  start  <serverId>
  stop   <serverId>

Options:
  --env <env>      dev, stage or prod (default: HEARTH_ENV or dev)
  --region <r>     the API's region (default: us-west-2)
  --no-wait        return once the request is accepted
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: 'string', default: process.env.HEARTH_ENV ?? 'dev' },
      region: { type: 'string', default: 'us-west-2' },
      version: { type: 'string' },
      game: { type: 'string', default: 'minecraft-java' },
      'game-region': { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, id] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  const api = apiClient({
    baseUrl: await findApiUrl(values.env, values.region),
    region: values.region,
    credentials: fromNodeProviderChain(),
  });
  const run = commands({ api, print: (line) => process.stdout.write(`${line}\n`) });
  const wait = !values['no-wait'];
  const needId = () => {
    if (!id) throw new CommandError(`${command} needs a server ID`);
    return id;
  };

  switch (command) {
    case 'create':
      if (!values.version) throw new CommandError('create needs --version, e.g. --version 1.21.4 (match your client)');
      await run.create({ game: values.game, version: values.version, region: values['game-region'], wait });
      return 0;
    case 'list':
      await run.list();
      return 0;
    case 'status':
      await run.status(needId());
      return 0;
    case 'start':
      await run.start(needId(), wait);
      return 0;
    case 'stop':
      await run.stop(needId(), wait);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ApiError) process.stderr.write(`API ${err.status}: ${err.message}\n`);
    else if (err instanceof CommandError) process.stderr.write(`${err.message}\n`);
    else process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
