// hearth: create and manage game servers through the Hearth API's admin routes.
// Signs requests with your AWS credentials (profile, environment or CloudShell).
import { parseArgs } from 'node:util';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { ApiError, apiClient, findApiUrl, invokeFleetCheck } from './client.js';
import { CommandError, commands } from './commands.js';

const USAGE = `Usage: hearth <command> [options]

  create --version <v> [--game minecraft-java] [--game-region <region>] [--channel canary|stable]
         [--upload <file.zip|file.tar.gz>]   start with this game data (e.g. a zipped Minecraft world); max 4 GiB
         [--from-upload <uploadId>]          start with an upload already accepted
  list [--all]                             servers; --all includes destroyed ones
  status <serverId>
  backups <serverId>                       the server's backups, newest first
  restore <serverId> [<key>] [--force]     replace the game data with a backup (default: newest) on the next start
  restore <serverId> --cancel              cancel a requested restore
  start  <serverId>
  stop   <serverId>
  destroy <serverId> [--yes]               delete a stopped server's instance and data volume; keeps its backups and record
  set-channel <serverId> <canary|stable>   agent releases to follow, from the next start
  set-version <serverId> <version>         a newer game release, from the next start (forward only)
  set-idle <serverId> <minutes|off>        stop after this long with nobody playing, from the next start
  fleet-check                              stuck, failed and mismatched servers; instances with no server

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
      channel: { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
      'from-upload': { type: 'string' },
      upload: { type: 'string' },
      force: { type: 'boolean', default: false },
      cancel: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, id, arg] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  const api = apiClient({
    baseUrl: await findApiUrl(values.env, values.region),
    region: values.region,
    credentials: fromNodeProviderChain(),
  });
  const run = commands({ api, fleetCheck: () => invokeFleetCheck(values.env, values.region), print: (line) => process.stdout.write(`${line}\n`) });
  const wait = !values['no-wait'];
  const needId = () => {
    if (!id) throw new CommandError(`${command} needs a server ID`);
    return id;
  };

  switch (command) {
    case 'create':
      if (!values.version) throw new CommandError('create needs --version, e.g. --version 1.21.4 (match your client)');
      await run.create({
        game: values.game,
        version: values.version,
        region: values['game-region'],
        channel: values.channel,
        upload: values['from-upload'],
        file: values.upload,
        wait,
      });
      return 0;
    case 'list':
      await run.list(values.all);
      return 0;
    case 'status':
      await run.status(needId());
      return 0;
    case 'backups':
      await run.backups(needId());
      return 0;
    case 'restore':
      if (values.cancel) await run.cancelRestore(needId());
      else await run.restore(needId(), arg, values.force);
      return 0;
    case 'start':
      await run.start(needId(), wait);
      return 0;
    case 'destroy':
      await run.destroy(needId(), { yes: values.yes, wait });
      return 0;
    case 'stop':
      await run.stop(needId(), wait);
      return 0;
    case 'set-channel':
      if (!arg) throw new CommandError('set-channel needs a channel: canary or stable');
      await run.setChannel(needId(), arg);
      return 0;
    case 'set-version':
      if (!arg) throw new CommandError('set-version needs a version, e.g. set-version <serverId> 26.4');
      await run.setVersion(needId(), arg);
      return 0;
    case 'set-idle':
      if (!arg) throw new CommandError('set-idle needs minutes or "off", e.g. set-idle <serverId> 30');
      await run.setIdle(needId(), arg);
      return 0;
    case 'fleet-check':
      await run.fleetCheck();
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
