import type { z } from 'zod';

/**
 * Checks `input` against an API schema (`@hearth/shared/api`): the value as the schema returns it,
 * or one readable line saying what's wrong (`version: must be a game version, e.g. 1.21.4`).
 */
export function check<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false; message: string } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const message = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return { ok: false, message };
}
