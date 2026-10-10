import { useState } from 'react';
import type { MeResponse } from '@hearth/shared';
import { displayName } from './Shell';

/** Their picture from Google or Discord, or their initial when there's none (or it won't load). */
export function Avatar({ me }: { me: MeResponse }) {
  const [broken, setBroken] = useState(false);
  if (me.picture && !broken) {
    return <img className="avatar" src={me.picture} alt="" width={32} height={32} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className="avatar avatar-initial" aria-hidden="true">{displayName(me).charAt(0).toUpperCase()}</span>;
}
