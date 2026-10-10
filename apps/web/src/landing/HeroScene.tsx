import { useEffect, useRef } from 'react';
import { canDrawWebGL, mountHearthScene } from './hearthScene';

/** The 3D hearth behind the hero. Draws nothing without WebGL; the hero reads the same. */
export default function HeroScene() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !canDrawWebGL()) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return mountHearthScene(host.current, { reduceMotion });
  }, []);
  return <div ref={host} className="scene-canvas" />;
}
