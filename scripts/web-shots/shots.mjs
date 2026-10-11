// Screenshots of the web app in headless Chromium, with console errors collected (CLAUDE.md:
// "To see the web app render"). Run in the Playwright image; see scripts/web-shots/README.md.
//   SITE   the site to load (default: the local build served on :8080)
//   MODE   landing (default): / at desktop and phone width, with the 3D scene
//          app: /app signed in, with config.json and the API mocked (waiting and approved users)
//          live: on a deployed site, Sign in must reach Cognito with the site's callback
/* global localStorage, history, window, Event -- in page.evaluate, which runs in the browser */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'http://localhost:8080';
const MODE = process.env.MODE ?? 'landing';
const OUT = process.env.OUT ?? '/shots';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

function watch(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

if (MODE === 'landing') {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = watch(page);
    await page.goto(`${SITE}/`);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: name === 'phone' });
    // Locally, /config.json is missing (a 404): expected.
    console.log(name, 'canvas:', !!(await page.$('canvas')), 'errors:', JSON.stringify(errors));
  }
}

if (MODE === 'app') {
  const config = { env: 'dev', apiUrl: 'https://api.test', auth: { region: 'us-west-2', domain: 'https://auth.test', clientId: 'c' } };
  const idToken = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;
  const base = { userId: 'u1', admin: false, serverLimit: 3, createdAt: '2026-10-10T00:00:00Z' };
  for (const [name, viewport, me] of [
    ['app-waiting', { width: 1280, height: 800 }, { ...base, approved: false, displayName: 'Ash' }],
    ['app-phone', { width: 390, height: 844 }, { ...base, approved: true, name: 'Sam Example' }],
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = watch(page);
    await page.route('**/config.json', (r) => r.fulfill({ json: config }));
    await page.route('https://api.test/**', (r) => r.fulfill({ json: me, headers: { 'access-control-allow-origin': '*' } }));
    await page.goto(`${SITE}/`);
    await page.evaluate((t) => localStorage.setItem('hearth.session', JSON.stringify({ idToken: t, refreshToken: 'r' })), idToken);
    // python's http.server has no fallback to index.html: load it, then route in the page.
    await page.goto(`${SITE}/index.html`);
    await page.evaluate(() => {
      history.replaceState(null, '', '/app');
      window.dispatchEvent(new Event('popstate'));
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, 'errors:', JSON.stringify(errors));
  }
}

if (MODE === 'live') {
  const page = await browser.newPage();
  const errors = watch(page);
  await page.goto(`${SITE}/`);
  await page.waitForTimeout(3000);
  console.log('landing errors:', JSON.stringify(errors));
  await page.click('text=Sign in');
  await page.waitForURL(/amazoncognito\.com/, { timeout: 15000 });
  const url = new URL(page.url());
  console.log('sign-in page:', url.origin + url.pathname, 'callback:', url.searchParams.get('redirect_uri'));
  await page.screenshot({ path: `${OUT}/live-login.png` });
}

await browser.close();
