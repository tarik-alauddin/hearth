import type { GameId } from '@hearth/shared';
import type { UploadRules } from '../rules.js';
import { minecraftJava } from './minecraft-java.js';

/** Upload rules for every game; a game missing here can't be started from an upload. */
export const UPLOAD_RULES: Partial<Record<GameId, UploadRules>> = {
  'minecraft-java': minecraftJava,
};
