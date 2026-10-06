export const GAMES = ['minecraft-java'] as const;

export type GameId = (typeof GAMES)[number];

/** Everything game-specific that infra, services and the UI share. */
export interface GameDefinition {
  readonly id: GameId;
  readonly displayName: string;
  /** Container image the agent runs. */
  readonly image: string;
  /** Port players connect to. */
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  /** Graviton instance type used unless the server overrides it. */
  readonly defaultInstanceType: string;
  /** Default size of the game data volume. */
  readonly dataVolumeGiB: number;
}

export const GAME_DEFINITIONS: Record<GameId, GameDefinition> = {
  'minecraft-java': {
    id: 'minecraft-java',
    displayName: 'Minecraft: Java Edition',
    image: 'docker.io/itzg/minecraft-server',
    port: 25565,
    protocol: 'tcp',
    defaultInstanceType: 't4g.medium',
    dataVolumeGiB: 10,
  },
};
