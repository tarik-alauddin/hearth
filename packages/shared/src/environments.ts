export const ENVIRONMENTS = ['dev', 'stage', 'prod'] as const;

export type EnvName = (typeof ENVIRONMENTS)[number];

export function isEnvName(value: unknown): value is EnvName {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}
