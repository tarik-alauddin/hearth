import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { UserRecord } from '../access.js';
import type { ServerRecord } from '../server.js';
import {
  AgentStatusReportSchema,
  CreateServerRequestSchema,
  IdleReportSchema,
  RestoreRequestSchema,
  ServerRecordSchema,
  UpdateSettingsRequestSchema,
  UserRecordSchema,
} from './schemas.js';

describe('API schemas', () => {
  it('describe the Servers record exactly as core stores it', () => {
    // ServerRecord stays a plain interface (core's storage type); its schema documents admin
    // responses. Adding a field to one without the other fails typechecking here.
    expectTypeOf<z.infer<typeof ServerRecordSchema>>().toEqualTypeOf<ServerRecord>();
  });

  it('accept a create request, and refuse unknown games, bad versions and unknown fields', () => {
    expect(CreateServerRequestSchema.safeParse({ game: 'minecraft-java', version: '1.21.4' }).success).toBe(true);
    for (const bad of [
      { game: 'doom', version: '1.21.4' },
      { game: 'minecraft-java', version: '1.21.4; rm -rf /' },
      { game: 'minecraft-java', version: '1.21.4', owner: 'someone-else' },
    ]) {
      expect(CreateServerRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('need at least one setting, within range', () => {
    expect(UpdateSettingsRequestSchema.safeParse({ idleStopMinutes: 0 }).success).toBe(true);
    expect(UpdateSettingsRequestSchema.safeParse({}).error?.issues[0]?.message).toBe('No settings given');
    expect(UpdateSettingsRequestSchema.safeParse({ idleStopMinutes: 1441 }).success).toBe(false);
    expect(UpdateSettingsRequestSchema.safeParse({ idleStopMinutes: 2.5 }).success).toBe(false);
  });

  it('take a restore with neither field (the newest backup), and refuse an empty key', () => {
    expect(RestoreRequestSchema.safeParse({}).success).toBe(true);
    expect(RestoreRequestSchema.safeParse({ key: '' }).success).toBe(false);
    expect(RestoreRequestSchema.safeParse({ force: 'yes' }).success).toBe(false);
  });

  it("hold the agent's reports to the limits the API always had", () => {
    expect(IdleReportSchema.safeParse({ idleMinutes: 0 }).success).toBe(false);
    expect(IdleReportSchema.safeParse({ idleMinutes: 1440 }).success).toBe(true);
    expect(AgentStatusReportSchema.safeParse({ state: 'ready', agentVersion: 'x'.repeat(65) }).success).toBe(false);
    expect(AgentStatusReportSchema.safeParse({ state: 'ready', agentVersion: '1', message: 'x'.repeat(501) }).success).toBe(false);
    expect(AgentStatusReportSchema.safeParse({ state: 'dancing', agentVersion: '1' }).success).toBe(false);
  });
});

describe('UserRecordSchema', () => {
  it('describes the Users record exactly as core stores it', () => {
    expectTypeOf<z.infer<typeof UserRecordSchema>>().toEqualTypeOf<UserRecord>();
  });
});
