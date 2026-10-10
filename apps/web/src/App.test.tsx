import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('leads with the pay-for-play promise and the wordmark', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Pay only when you play.');
    expect(html).toContain('Hearth');
  });
});
