// @vitest-environment happy-dom
// The bottom sheet's content is swapped in place (innerHTML). Without moving
// focus, a keyboard or screen-reader user is left on a button that no longer
// exists (focus falls to <body>). Each new sheet focuses its title; Back
// returns focus to where the person came from.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { focusSheet, SHEET_TITLE } from '../src/sheet-focus';

describe('focusSheet', () => {
  it('focuses the sheet title', () => {
    document.body.innerHTML = `<div id="panel"><div class="sheet"><strong ${SHEET_TITLE}>Point details</strong><button>Save</button></div></div>`;
    focusSheet(document.getElementById('panel')!);
    expect(document.activeElement?.textContent).toBe('Point details');
  });
  it('focuses the given control instead, when it is there (Back to a row)', () => {
    document.body.innerHTML = `<div id="panel"><strong ${SHEET_TITLE}>Manage map</strong><button class="point-row" data-id="r2">Neem</button></div>`;
    focusSheet(document.getElementById('panel')!, '.point-row[data-id="r2"]');
    expect(document.activeElement?.textContent).toBe('Neem');
  });
  it('falls back to the title when the control has gone (the point was deleted)', () => {
    document.body.innerHTML = `<div id="panel"><strong ${SHEET_TITLE}>Manage map</strong></div>`;
    focusSheet(document.getElementById('panel')!, '.point-row[data-id="gone"]');
    expect(document.activeElement?.textContent).toBe('Manage map');
  });
  it('the title can take focus from script but is not a Tab stop', () => {
    expect(SHEET_TITLE).toContain('tabindex="-1"');
  });
});

const app = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
const body = (name: string): string => {
  const start = app.indexOf(`function ${name}(`);
  return app.slice(start, app.indexOf('\n}\n', start));
};

describe('the collect sheets move focus', () => {
  for (const fn of ['detailsSheet', 'manageSheet', 'openReview', 'editSettings', 'editFormSheet']) {
    it(`${fn} has a focusable title and focuses after rendering`, () => {
      expect(body(fn)).toContain('${SHEET_TITLE}');
      expect(body(fn)).toMatch(/focusSheet\(/);
    });
  }
  it('Back from a point returns focus to its row in the list', () => {
    expect(body('openReview')).toMatch(/manageSheet\(\{ row: /);
    expect(body('pointRowsHtml')).toMatch(/data-id="\$\{escapeHtml\(String\(f\.id\)\)\}"/);
  });
  it('Back from the details form returns focus to "Add point"', () => {
    expect(body('detailsSheet')).toMatch(/renderPlaceBar\(modes, '#place'\)/);
  });
});

describe('Manage sections', () => {
  // A tablist needs aria-controls, a labelled tabpanel and arrow keys; plain
  // toggle buttons (like the basemap switcher) need none of that.
  it('are pressed-state buttons in a group, not a half-built tablist', () => {
    const m = body('manageSheet');
    expect(m).not.toContain('role="tablist"');
    expect(m).not.toContain('role="tab"');
    expect(m).toMatch(/id="mtabs" role="group"/);
    expect(body('renderManageTab')).toMatch(/setPressed\(b, /);
  });
});

describe('the Review list on a big map', () => {
  it('renders a page of rows with "Show more", not every record at once', () => {
    const r = body('renderPoints');
    expect(r).toMatch(/rowsToShow\(/);
    expect(r).toMatch(/pointRowsHtml\(0, reviewShown\) \+ showMoreHtml\(\)/);
    expect(body('showMoreHtml')).toContain('Show more');
  });
  it('the background refresh compares reviewSignature, not a string of every id', () => {
    expect(app).not.toMatch(/allFeats\.map\(\(f\) => `\$\{f\.id\}:\$\{statusOf\(f\)\}`\)\.join/);
    expect(app).toMatch(/reviewSignature\(allFeats\)/);
  });
});

describe('recording a walk', () => {
  // Every GPS fix rewrites the vertex count: announcing each one drowns a
  // screen reader. It is quiet while recording and speaks once it stops.
  it('turns the count\'s live region off while a walk records', () => {
    expect(app).toMatch(/vcount[^\n]*setAttribute\('aria-live', [^\n]*'off'/);
  });
});
