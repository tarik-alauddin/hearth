// Draws the landing scene (world.ts) with three.js: the islands as lit surfaces (surfaces.ts: light
// baked in, Minecraft-style), the fire and its embers, a glow on everything that burns, the torches
// lighting one by one as the page opens, and a slow camera drift. Loaded on its own, after the
// page's text, so the 3D never delays the first paint.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  NearestMipmapLinearFilter,
  PerspectiveCamera,
  SRGBColorSpace,
  PointLight,
  Points,
  PointsMaterial,
  RGBAFormat,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { allFaces, buildPlants, texturedBox, type Shape } from './models';
import { buildSurfaces, lightRgb, spreadLight } from './surfaces';
import { buildAtlas, SKINS } from './textures';
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
  renderer.setClearColor(NIGHT);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  // The sky as the scene's background, not the renderer's clear colour: the glow pass renders into
  // its own target, and only the background is colour-managed there.
  scene.background = new Color(NIGHT);
  scene.fog = new FogExp2(NIGHT, 0.022);
  const camera = new PerspectiveCamera(38, 1, 0.1, 200);

  // The blocks carry their light baked in; these lights are for the few moving things (the logs,
  // torch posts). Physical units: point lights fall off with distance squared.
  scene.add(new HemisphereLight(0x5a6aa8, 0x1a1d26, 2.4));
  const moon = new DirectionalLight(0x8ea4ff, 1.1);
  moon.position.set(-20, 30, -10);
  scene.add(moon);

  // Every block, as one surface with its light baked in (unlit: what you see is the baked colour).
  // As the page opens the torches light, so the colours blend from moonlight to lit.
  const surfaces = buildSurfaces(world);
  const moonlit = buildSurfaces(world, { moonOnly: true }).colors;
  const shown = reduceMotion ? surfaces.colors : moonlit.slice();
  const ground = new BufferGeometry();
  ground.setAttribute('position', new BufferAttribute(surfaces.positions, 3));
  ground.setAttribute('color', new BufferAttribute(shown, 3));
  ground.setAttribute('uv', new BufferAttribute(surfaces.uvs, 2));
  ground.setIndex(new BufferAttribute(surfaces.indices, 1));
  // The block textures: crisp pixels up close (nearest), smoothed mipmaps far off, as in the game.
  const atlas = buildAtlas();
  const texture = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  const textured = new MeshBasicMaterial({ map: texture, vertexColors: true });
  scene.add(new Mesh(ground, textured));

  /** A shape (models.ts) as geometry the renderer can draw. */
  const toGeometry = (shape: Shape) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(shape.positions), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(shape.uvs), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(shape.colors), 3));
    g.setIndex(shape.indices);
    return g;
  };
  const blockLight = spreadLight(world);
  const lightAround = (x: number, y: number, z: number) => lightRgb((blockLight.get(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`) ?? 0) / 15);

  // Flowers and tall grass: see-through textures on crossed planes, seen from both sides.
  scene.add(new Mesh(toGeometry(buildPlants(world)), new MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: 0.5, side: DoubleSide })));
  const cube = new BoxGeometry(1, 1, 1);

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

  // Torches, Minecraft's shape: a thin stick and a glowing head, lit one by one as the page opens.
  const stickMat = new MeshBasicMaterial({ color: 0x6b4a2e });
  const stickGeo = new BoxGeometry(0.13, 0.62, 0.13);
  const headGeo = new BoxGeometry(0.15, 0.17, 0.15);
  const torches = world.torches.map((t, i) => {
    const stick = new Mesh(stickGeo, stickMat);
    stick.position.set(t.x, 0.81, t.z);
    scene.add(stick);
    const headMat = new MeshBasicMaterial({ color: 0x3a2a1a });
    const head = new Mesh(headGeo, headMat);
    head.position.set(t.x, 1.2, t.z);
    scene.add(head);
    return { headMat, head, delay: 0.6 + i * 0.4 };
  });

  // The cottage window: a framed pane that lights up after the torches.
  const windowMat = new MeshBasicMaterial({ map: texture, vertexColors: true });
  windowMat.color.setScalar(0.15);
  const w = world.window;
  scene.add(new Mesh(toGeometry(texturedBox([w.x, w.y, w.z], [0.12, 1, 1], { ...allFaces('planks'), left: 'window', right: 'window' })), windowMat));

  // Chimney smoke: puffs that rise, drift, swell and fade, one after another.
  const PUFFS = 10;
  const puffGeo = new BoxGeometry(1, 1, 1);
  const puffs = Array.from({ length: PUFFS }, (_, i) => {
    const mat = new MeshBasicMaterial({ color: 0x8c93a6, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new Mesh(puffGeo, mat);
    scene.add(mesh);
    return { mesh, mat, phase: i / PUFFS };
  });

  // Clouds: flat, blocky, slow, lit by the moon.
  const cloudMat = new MeshBasicMaterial({ color: 0x3c4766, transparent: true, opacity: 0.5, depthWrite: false });
  const clouds = Array.from({ length: 7 }, () => {
    const mesh = new Mesh(new BoxGeometry(5 + Math.round(rand() * 7), 1, 3 + Math.round(rand() * 4)), cloudMat);
    mesh.position.set(-40 + rand() * 80, 17 + rand() * 4, -30 + rand() * 50);
    scene.add(mesh);
    return mesh;
  });

  // The players: original characters (not Steve), in the game's proportions (a 1.8-block figure:
  // head 0.45, body and limbs 0.675), skinned from the atlas and lit by the light where they stand.
  // Arms and head move from their shoulders and neck.
  const part = (shape: Shape) => new Mesh(toGeometry(shape), textured);
  const players = world.players.map((p) => {
    const t = SKINS[p.skin];
    const figure = new Group();
    const glow = lightAround(p.x, 1, p.z);
    const limb = (x: number, faces: Parameters<typeof texturedBox>[2]) => {
      const pivot = new Group();
      pivot.position.set(x, 1.35, 0); // the shoulder or hip
      pivot.add(part(texturedBox([0, -0.3375, 0], [0.225, 0.675, 0.225], faces, glow)));
      figure.add(pivot);
      return pivot;
    };
    for (const x of [-0.1125, 0.1125]) limb(x, allFaces(t.trousers)).position.y = 0.675; // hips
    figure.add(part(texturedBox([0, 1.0125, 0], [0.45, 0.675, 0.225], { front: t.tunic, back: t.tunicBack, left: t.tunicBack, right: t.tunicBack, top: t.tunicBack, bottom: t.trousers }, glow)));
    const arms = [-0.3375, 0.3375].map((x) => limb(x, { ...allFaces(t.sleeve), top: t.tunicBack }));
    const head = new Group();
    head.position.set(0, 1.35, 0); // the neck
    head.add(part(texturedBox([0, 0.225, 0], [0.45, 0.45, 0.45], { front: t.face, back: t.hairBack, left: t.hairSide, right: t.hairSide, top: t.hairTop, bottom: t.hairSide }, glow)));
    figure.add(head);
    figure.position.set(p.x, 0.5, p.z);
    figure.rotation.y = p.facing;
    scene.add(figure);
    return { figure, head, arms, pose: p.pose, phase: p.x };
  });

  // A glow on what burns (fire, torches, the window, embers): only the brightest pixels bloom.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.85, 0.55, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
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
      const flicker = reduceMotion ? 1 : 0.88 + 0.12 * Math.sin(now * 11 + t.delay * 7) * Math.sin(now * 7.3 + t.delay);
      // Near white when lit: bright enough for the glow pass, not so bright that it streaks.
      t.headMat.color.setRGB((0.23 + 1.3 * level) * flicker, (0.16 + 1.0 * level) * flicker, 0.1 + 0.32 * level, SRGBColorSpace);
      t.head.scale.y = reduceMotion ? 1 : 0.9 + 0.12 * flicker;
    }
    const lit = reduceMotion ? 1 : clamp01((since - 2.4) / 0.6);
    windowMat.color.setScalar(0.15 + 1.45 * lit);

    for (const p of puffs) {
      const t = reduceMotion ? p.phase : (now / 5 + p.phase) % 1; // each puff lives 5 seconds
      const c = world.chimney;
      p.mesh.position.set(c.x + Math.sin(t * 5 + p.phase * 9) * 0.35 + t * 1.2, c.y + 0.6 + t * 4.5, c.z + t * 0.6);
      p.mesh.scale.setScalar(0.22 + t * 0.45);
      p.mat.opacity = 0.3 * Math.min(1, t * 5) * (1 - t) * lit;
    }
    if (!reduceMotion) {
      for (const cloud of clouds) {
        cloud.position.x += dt * 0.35;
        if (cloud.position.x > 45) cloud.position.x = -45;
      }
    }
    // The island warms up as its torches light (over the first few seconds only).
    if (!reduceMotion && since < 4) {
      const warm = clamp01((since - 0.6) / 2.4);
      for (let i = 0; i < shown.length; i++) shown[i] = moonlit[i]! + (surfaces.colors[i]! - moonlit[i]!) * warm;
      ground.attributes.color!.needsUpdate = true;
    }
    for (const pl of players) {
      const k = reduceMotion ? 0 : now + pl.phase;
      if (pl.pose === 'pointing') {
        // Looking up at the tower, right arm raised towards it.
        pl.head.rotation.x = -0.38 + 0.05 * Math.sin(k * 0.9);
        pl.head.rotation.y = 0.12 * Math.sin(k * 0.5);
        pl.arms[1]!.rotation.x = -2.3 + 0.12 * Math.sin(k * 2.1);
        pl.arms[0]!.rotation.x = 0.06 * Math.sin(k * 1.3);
      } else {
        pl.head.rotation.y = 0.35 * Math.sin(k * 0.4); // looking round
        pl.head.rotation.x = 0.06 * Math.sin(k * 0.7);
        pl.arms[0]!.rotation.x = 0.07 * Math.sin(k * 1.3);
        pl.arms[1]!.rotation.x = -0.07 * Math.sin(k * 1.3);
      }
      pl.figure.position.y = 0.5 + Math.abs(Math.sin(k * 1.3)) * 0.015; // breathing
    }

    composer.render();
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Points) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) mat.dispose();
      }
    });
    texture.dispose();
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
