import { describe, expect, it } from 'vitest';
import { leavesPage, subframeLeaves } from './navigation';

describe('leavesPage', () => {
  const page = 'file:///Applications/ARcode.app/Contents/Resources/app.asar/out/renderer/index.html?view=project';

  it('blocks a dropped file and web pages', () => {
    expect(leavesPage(page, 'file:///Users/me/Desktop/shot.png')).toBe(true);
    expect(leavesPage(page, 'https://example.com/')).toBe(true);
    expect(leavesPage('http://localhost:5173/?view=project', 'http://localhost:5174/')).toBe(true);
  });

  it('lets the page reload itself', () => {
    expect(leavesPage(page, `${page}#top`)).toBe(false);
    expect(leavesPage('http://localhost:5173/?view=project', 'http://localhost:5173/?view=project')).toBe(false);
  });

  it('blocks anything it cannot parse', () => {
    expect(leavesPage(page, 'not a url')).toBe(true);
  });
});

describe('subframeLeaves', () => {
  it('blocks web pages, mail links and local files inside frames', () => {
    expect(subframeLeaves('https://example.com/')).toBe(true);
    expect(subframeLeaves('mailto:me@example.com')).toBe(true);
    expect(subframeLeaves('file:///etc/hosts')).toBe(true);
  });

  it('lets the PDF frame load and move within its document', () => {
    expect(subframeLeaves('arcode-pdf://doc/out/plan.pdf?root=%2Fp&v=1')).toBe(false);
    expect(subframeLeaves('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')).toBe(false);
    expect(subframeLeaves('about:blank')).toBe(false);
  });
});
