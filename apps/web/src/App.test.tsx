import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  const html = renderToString(<App />);

  it('leads with the pay-for-play promise and the wordmark', () => {
    expect(html).toContain('Pay only when you play.');
    expect(html).toContain('Hearth');
  });

  it("says plainly it isn't affiliated with Minecraft's makers", () => {
    expect(html).toContain('Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.');
  });

  it('keeps the copy free of implementation details', () => {
    expect(html).not.toMatch(/\b\d+ (minutes|backups)\b|newest 10|Google|Discord/);
  });

  it('renders the text without the 3D scene (it loads later, on its own)', () => {
    expect(html).not.toContain('<canvas');
  });
});
