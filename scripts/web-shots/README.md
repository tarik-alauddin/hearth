# Web app screenshots

`shots.mjs` loads the web app in headless Chromium (Playwright in Docker) and saves screenshots
plus console errors. Build first (`pnpm --filter @hearth/web build`), then from the repo root in
Git Bash (PNGs land in `scripts/web-shots/out/`, gitignored):

```sh
mkdir -p scripts/web-shots/out
docker run --rm -e MODE=landing \
  -v "$(cd apps/web/dist && pwd -W):/dist:ro" -v "$(cd scripts/web-shots && pwd -W):/scripts:ro" \
  -v "$(cd scripts/web-shots/out && pwd -W):/shots" mcr.microsoft.com/playwright:v1.50.0-noble bash -c \
  'mkdir /w && cp /scripts/shots.mjs /w && cd /w && npm i -s playwright@1.50.0 >/dev/null 2>&1;
   (cd /dist && python3 -m http.server 8080 >/dev/null 2>&1 &); sleep 1; node shots.mjs'
```

- `MODE=app`: `/app` signed in, API mocked.
- `MODE=live -e SITE=<web-url>`: the deployed site (it sends the real content policy; drop the
  `/dist` mount and server).

On macOS or Linux use `$(pwd)` paths instead of `pwd -W`.
