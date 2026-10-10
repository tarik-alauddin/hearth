// Draws the landing scene (world.ts) with three.js: the islands, the fire and its embers, the
// torches lighting one by one as the page opens, and a slow camera drift. Loaded on its own, after
// the page's text, so the 3D never delays the first paint.
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildWorld, COLORS, seeded } from './world';

const NIGHT = 0x0d1018;
/** Where the camera looks: between the hearth and the Minecraft island. */
const LOOK_AT = new Vector3(2.5, 0.5, 1.5);

export interface SceneOptions {
  /** Still: no drift, no flicker; the torches are lit from the start. */
  reduceMotion: boolean;
}

/** Whether this browser can draw WebGL at all (the page reads fine without it). */
export function canDrawWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Draws the scene into `host` until the returned function is called. */
export function mountHearthScene(host: HTMLElement, { reduceMotion }: SceneOptions): () => void {
  const world = buildWorld();
  const rand = seeded(11);

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(NIGHT);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.fog = new FogExp2(NIGHT, 0.022);
  const camera = new PerspectiveCamera(38, 1, 0.1, 200);

  // Night light: a cool moon and a dim sky; the fire does the real work. (Physical light units:
  // point lights fall off with the square of distance.)
  scene.add(new HemisphereLight(0x3a4a78, 0x0b0d12, 1.7));
  const moon = new DirectionalLight(0x8ea4ff, 1.1);
  moon.position.set(-20, 30, -10);
  scene.add(moon);

  // Every static block in one instanced mesh.
  const cube = new BoxGeometry(1, 1, 1);
  const blocks = new InstancedMesh(cube, new MeshLambertMaterial({ color: 0xffffff }), world.voxels.length);
  const m = new Matrix4();
  const c = new Color();
  world.voxels.forEach((v, i) => {
    blocks.setMatrixAt(i, m.makeTranslation(v.x, v.y, v.z));
    blocks.setColorAt(i, c.setHex(v.color));
  });
  scene.add(blocks);

  // The fire: crossed logs, flickering cubes, a warm light that always burns.
  const logMat = new MeshLambertMaterial({ color: COLORS.logs });
  const logGeo = new BoxGeometry(1.8, 0.3, 0.3);
  for (const angle of [0.4, 0.4 + Math.PI / 2]) {
    const log = new Mesh(logGeo, logMat);
    log.position.set(0, 0.7, 0);
    log.rotation.y = angle;
    scene.add(log);
  }
  const fire = new Group();
  scene.add(fire);
  const flameColors = [0xffc46b, 0xff8a3d, 0xff5e1f];
  const flames = Array.from({ length: 7 }, (_, i) => {
    const mesh = new Mesh(cube, new MeshBasicMaterial({ color: flameColors[i % 3] }));
    fire.add(mesh);
    return {
      mesh,
      base: new Vector3((rand() - 0.5) * 0.6, 0.95 + rand() * 0.5, (rand() - 0.5) * 0.6),
      size: 0.28 + rand() * 0.22,
      phase: rand() * 6,
    };
  });
  const fireLight = new PointLight(0xff8a3d, 70, 30, 2);
  fireLight.position.set(0, 2, 0);
  scene.add(fireLight);

  // Embers drifting up from the fire.
  const EMBERS = 70;
  const emberPos = new Float32Array(EMBERS * 3);
  const emberSpeed = new Float32Array(EMBERS);
  const resetEmber = (i: number, anywhere: boolean) => {
    emberPos[i * 3] = (rand() - 0.5) * 0.8;
    emberPos[i * 3 + 1] = 1 + (anywhere ? rand() * 8 : 0);
    emberPos[i * 3 + 2] = (rand() - 0.5) * 0.8;
    emberSpeed[i] = 0.6 + rand() * 0.9;
  };
  for (let i = 0; i < EMBERS; i++) resetEmber(i, true);
  const emberGeo = new BufferGeometry();
  emberGeo.setAttribute('position', new BufferAttribute(emberPos, 3));
  scene.add(new Points(emberGeo, new PointsMaterial({ color: 0xffa24a, size: 0.14, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })));

  // Stars.
  const STARS = 420;
  const starPos = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = rand() * 0.45 * Math.PI;
    starPos.set([90 * Math.cos(theta) * Math.cos(phi), 10 + 90 * Math.sin(phi), 90 * Math.sin(theta) * Math.cos(phi)], i * 3);
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new BufferAttribute(starPos, 3));
  scene.add(new Points(starGeo, new PointsMaterial({ color: 0xc9d3ff, size: 0.35, transparent: true, opacity: 0.7, fog: false })));

  // The gold catches the light.
  const goldGlow = new PointLight(0xffd36b, 1.5, 6, 2);
  goldGlow.position.set(world.pimps.x + 0.8, 4, world.pimps.z + 0.8);
  scene.add(goldGlow);

  // Torches, lit one by one as the page opens; then the cottage window.
  const postGeo = new BoxGeometry(0.22, 1, 0.22);
  const tipGeo = new BoxGeometry(0.28, 0.28, 0.28);
  const torches = world.torches.map((t, i) => {
    const post = new Mesh(postGeo, logMat);
    post.position.set(t.x, 1, t.z);
    scene.add(post);
    const tipMat = new MeshBasicMaterial({ color: 0x3a2a1a });
    const tip = new Mesh(tipGeo, tipMat);
    tip.position.set(t.x, 1.62, t.z);
    scene.add(tip);
    const light = new PointLight(0xffa040, 0, 8, 2);
    light.position.set(t.x, 2, t.z);
    scene.add(light);
    return { tipMat, light, delay: 0.6 + i * 0.4 };
  });
  const windowMat = new MeshBasicMaterial({ color: 0x1a1410 });
  const pane = new Mesh(new BoxGeometry(0.15, 0.9, 0.9), windowMat);
  pane.position.set(world.window.x, world.window.y, world.window.z);
  scene.add(pane);

  // A blocky friend on the path (an original character, not Steve): ember scarf, slate tunic.
  const friend = new Group();
  const part = (w: number, h: number, d: number, color: number, x: number, y: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshLambertMaterial({ color }));
    mesh.position.set(x, y, 0);
    friend.add(mesh);
  };
  part(0.24, 0.7, 0.26, 0x2c3344, -0.13, 0.35);
  part(0.24, 0.7, 0.26, 0x2c3344, 0.13, 0.35);
  part(0.56, 0.72, 0.32, 0x4b5a78, 0, 1.06);
  part(0.62, 0.16, 0.38, 0xff8a3d, 0, 1.36);
  part(0.5, 0.5, 0.5, 0xd8a77f, 0, 1.7);
  part(0.54, 0.16, 0.54, 0x3b2a1e, 0, 1.98);
  friend.position.set(world.friend.x, 0.5, world.friend.z);
  friend.rotation.y = 0.5;
  scene.add(friend);

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 760 ? 46 : 38; // narrow screens: pull back so the islands still fit
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const start = performance.now() / 1000;
  let last = start;
  let angle = 0.55;
  let frameId = 0;
  const frame = () => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - last);
    last = now;
    const since = now - start;

    if (!reduceMotion) angle += dt * 0.035;
    camera.position.set(LOOK_AT.x + 31 * Math.sin(angle), 15, LOOK_AT.z + 31 * Math.cos(angle));
    camera.lookAt(LOOK_AT);

    flames.forEach((f, i) => {
      const k = reduceMotion ? 0 : now * 6 + f.phase;
      f.mesh.scale.setScalar(f.size * (0.85 + 0.25 * Math.sin(k) * Math.sin(k * 0.7 + i)));
      f.mesh.position.set(f.base.x, f.base.y + 0.12 * Math.sin(k * 0.8), f.base.z);
    });
    fireLight.intensity = 64 + (reduceMotion ? 0 : 10 * Math.sin(now * 9) * Math.sin(now * 5.3));

    if (!reduceMotion) {
      for (let i = 0; i < EMBERS; i++) {
        emberPos[i * 3 + 1] = (emberPos[i * 3 + 1] ?? 0) + dt * (emberSpeed[i] ?? 1) * 1.6;
        emberPos[i * 3] = (emberPos[i * 3] ?? 0) + Math.sin(now + i) * dt * 0.25;
        if ((emberPos[i * 3 + 1] ?? 0) > 9) resetEmber(i, false);
      }
      emberGeo.attributes.position!.needsUpdate = true;
    }

    for (const t of torches) {
      const level = reduceMotion ? 1 : clamp01((since - t.delay) / 0.4);
      const flicker = reduceMotion ? 1 : 0.85 + 0.15 * Math.sin(now * 11 + t.delay * 7);
      t.light.intensity = 6 * level * flicker;
      t.tipMat.color.setRGB(0.23 + 0.77 * level, 0.16 + 0.6 * level, 0.1 + 0.15 * level, SRGBColorSpace);
    }
    const lit = reduceMotion ? 1 : clamp01((since - 2.4) / 0.6);
    windowMat.color.setRGB(0.1 + 0.9 * lit, 0.08 + 0.62 * lit, 0.06 + 0.24 * lit, SRGBColorSpace);
    if (!reduceMotion) friend.position.y = 0.5 + Math.abs(Math.sin(now * 2)) * 0.04;

    renderer.render(scene, camera);
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Points || o instanceof InstancedMesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) mat.dispose();
      }
    });
    renderer.dispose();
    renderer.domElement.remove();
  };
}
