import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { settle } from '../../../../testing/auth-testing';
import { stubScrolling } from '../../../../testing/prosemirror-jsdom';
import { MEMBERS, PROPERTIES, database, page, row, rows } from '../../../../testing/database-testing';
import { Database, Property, Row } from '../database.api';
import { DatabaseView } from '../database-view';
import { MAX_VISIBLE_ROWS, ROW_HEIGHT } from './table';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('Table lens (T17)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<DatabaseView>;
  let element: HTMLElement;
  let scrollTop = 0;

  async function stable() {
    await settle();
    await fixture.whenStable();
    await frame();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /** Open the database page and answer its requests. */
  async function open(results: Row[], options: { db?: Database; cursor?: string | null; readOnly?: boolean } = {}) {
    fixture = TestBed.createComponent(DatabaseView);
    element = fixture.nativeElement;
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.componentRef.setInput('title', 'Tasks');
    fixture.componentRef.setInput('readOnly', options.readOnly ?? false);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/pages/p1/database').flush(options.db ?? database());
    await settle();
    const query = http.expectOne('/api/databases/db1/query');
    expect(query.request.body).toEqual({ view_id: 'v1', page_size: 100 });
    query.flush(page(results, options.cursor ?? null));
    http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
    sizeViewport();
    await stable();
  }

  /** jsdom has no layout: give the viewport its height and a working scrollTop. */
  function sizeViewport() {
    const viewportElement = element.querySelector<HTMLElement>('cdk-virtual-scroll-viewport')!;
    scrollTop = 0;
    Object.defineProperty(viewportElement, 'clientHeight', { configurable: true, get: () => ROW_HEIGHT * MAX_VISIBLE_ROWS });
    Object.defineProperty(viewportElement, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
    });
    viewport().checkViewportSize();
  }

  const viewport = () =>
    fixture.debugElement.query(By.directive(CdkVirtualScrollViewport)).injector.get(CdkVirtualScrollViewport);

  async function scrollTo(px: number) {
    scrollTop = px;
    element.querySelector('cdk-virtual-scroll-viewport')!.dispatchEvent(new Event('scroll'));
    await frame(); // the viewport updates on the next animation frame
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const grid = () => element.querySelector<HTMLElement>('[role="grid"]')!;
  const renderedRows = () => Array.from(element.querySelectorAll<HTMLElement>('.body [role="row"]'));
  const cell = (r: number, c: number) => element.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`)!;
  const col = (id: string) => PROPERTIES.findIndex((p) => p.id === id);
  const headers = () => Array.from(element.querySelectorAll('[role="columnheader"]')).map((h) => h.textContent!.trim());
  const key = async (target: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    await stable();
  };
  const editor = (r: number, c: number) => cell(r, c).querySelector<HTMLInputElement & HTMLSelectElement>('.editor')!;
  const patch = (rowId: string): TestRequest => http.expectOne(`/api/databases/db1/rows/${rowId}`);

  beforeAll(() => {
    stubScrolling();
  });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  describe('showing rows', () => {
    it('shows properties as columns and every type of value', async () => {
      await open([
        row('a', 'Launch', {
          notes: 'Ship it',
          points: 1234.5,
          priority: 'high',
          tags: ['api', 'web'],
          state: 'done',
          due: { start: '2026-11-05', end: '2026-11-09' },
          owner: ['u-ada', 'u-bob'],
          done: true,
          link: 'https://example.com',
        }),
        row('b', ''),
      ]);
      expect(headers()).toEqual([...PROPERTIES.map((p) => p.name), '+']);
      const texts = PROPERTIES.map((_, c) => (cell(0, c).querySelector('.value, .chips') ?? cell(0, c)).textContent!.trim());
      expect(texts).toEqual([
        'Launch',
        'Ship it',
        '1,234.5',
        'High',
        'APIWeb',
        'Done',
        'Nov 5, 2026 → Nov 9, 2026',
        'ada@example.com, bob@example.com',
        '',
        'https://example.com',
      ]);
      expect(cell(0, col('done')).querySelector<HTMLInputElement>('input')!.checked).toBe(true);
      expect(cell(0, col('priority')).querySelector('.chip')!.getAttribute('data-color')).toBe('red');
      const link = cell(0, col('link')).querySelector('a')!;
      expect([link.target, link.rel]).toEqual(['_blank', 'noopener noreferrer']);
      expect(cell(1, 0).querySelector('.value')!.textContent!.trim()).toBe('Untitled');
      expect(cell(0, 0).querySelector('button')!.getAttribute('aria-label')).toBe('Open Launch');
      expect(cell(0, col('points')).getAttribute('aria-label')).toBe('Points: 1,234.5');
      expect(cell(1, col('notes')).getAttribute('aria-label')).toBe('Notes: empty');
    });

    it('is an ARIA grid with row and column counts', async () => {
      await open(rows(3));
      expect(grid().getAttribute('aria-label')).toBe('Tasks table');
      expect(grid().getAttribute('aria-rowcount')).toBe('4'); // header + 3
      expect(grid().getAttribute('aria-colcount')).toBe(String(PROPERTIES.length));
      expect(renderedRows()[0].getAttribute('aria-rowindex')).toBe('2');
      expect(cell(0, 0).getAttribute('tabindex')).toBe('0'); // the way in
      expect(cell(0, 1).getAttribute('tabindex')).toBe('-1');
    });

    it('shows the view\'s visible properties, in its order', async () => {
      const db = database(PROPERTIES, {
        views: [{ id: 'v1', name: 'Table', layout: 'table', config: { visible_properties: ['done', 'notes'], widths: { notes: 320 } }, position: 0 }],
      });
      await open(rows(1), { db });
      expect(headers()).toEqual(['Name', 'Done', 'Notes', '+']);
      expect(cell(0, 2).style.width).toBe('320px');
    });
  });

  describe('10,000 rows (perf)', () => {
    /** Average time per jump to `offsets` (each jump shows a whole new screenful of rows). */
    async function timeJumps(offsets: number[]): Promise<number> {
      const bound = MAX_VISIBLE_ROWS * 3;
      let total = 0;
      for (const offset of offsets) {
        const started = performance.now();
        await scrollTo(offset);
        total += performance.now() - started;
        expect(renderedRows().length).toBeLessThan(bound); // never more than about a screenful
      }
      return total / offsets.length;
    }

    const screen = ROW_HEIGHT * MAX_VISIBLE_ROWS;

    it('keeps only the rows in view in the page, wherever it scrolls', async () => {
      await open(rows(10_000));
      expect(grid().getAttribute('aria-rowcount')).toBe('10001');
      expect(renderedRows().length).toBeGreaterThan(0);
      expect(renderedRows().length).toBeLessThan(MAX_VISIBLE_ROWS * 3);
      const offsets = Array.from({ length: 40 }, (_, i) => Math.round(((i + 1) * 10_000 * ROW_HEIGHT) / 40) - screen);
      await timeJumps(offsets);
      expect(renderedRows().at(-1)!.textContent).toContain('Row 9999'); // the end is reachable
    });

    it('scrolls 10,000 rows as fast as 100: the cost depends on the screen, not the row count', async () => {
      await open(rows(100));
      const far = 100 * ROW_HEIGHT - screen;
      const alternate = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0 : far));
      const small = await timeJumps(alternate);
      fixture.destroy();

      await open(rows(10_000));
      const big = await timeJumps(Array.from({ length: 20 }, (_, i) => ((i * 4973) % 9_800) * ROW_HEIGHT));
      expect(big).toBeLessThan(small * 2 + 15);
      expect(big).toBeLessThan(250); // and never slow outright, even on a busy machine
    });

    it('loads the next page of rows as the end comes into view', async () => {
      await open(rows(100), { cursor: 'c1' });
      expect(grid().getAttribute('aria-rowcount')).toBe('-1'); // more to come
      await scrollTo(80 * ROW_HEIGHT);
      const more = http.expectOne('/api/databases/db1/query');
      expect(more.request.body).toEqual({ view_id: 'v1', page_size: 100, cursor: 'c1' });
      more.flush(page(rows(50, 100)));
      await stable();
      expect(grid().getAttribute('aria-rowcount')).toBe('151');
      await scrollTo(140 * ROW_HEIGHT);
      http.expectNone('/api/databases/db1/query'); // nothing more to load
    });
  });

  describe('keyboard', () => {
    it('moves between cells with arrows, Home and End', async () => {
      await open(rows(5));
      cell(0, 0).click();
      await stable();
      expect(document.activeElement).toBe(cell(0, 0));
      await key(cell(0, 0), 'ArrowRight');
      await key(cell(0, 1), 'ArrowDown');
      expect(document.activeElement).toBe(cell(1, 1));
      expect(cell(1, 1).getAttribute('tabindex')).toBe('0');
      await key(cell(1, 1), 'End');
      expect(document.activeElement).toBe(cell(1, PROPERTIES.length - 1));
      await key(document.activeElement as HTMLElement, 'Home');
      expect(document.activeElement).toBe(cell(1, 0));
      await key(cell(1, 0), 'ArrowUp');
      await key(cell(0, 0), 'ArrowUp'); // stays at the edge
      expect(document.activeElement).toBe(cell(0, 0));
    });
  });

  describe('editing', () => {
    async function editTitle(rowIndex: number) {
      cell(rowIndex, 0).click();
      await stable();
      await key(cell(rowIndex, 0), 'Enter');
      return editor(rowIndex, 0);
    }

    it('Enter edits, Enter saves and moves down', async () => {
      await open([row('a', 'Old'), row('b', 'Next')]);
      const input = await editTitle(0);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('Old');
      input.value = 'New title';
      await key(input, 'Enter');
      const request = patch('a');
      expect([request.request.method, request.request.body]).toEqual(['PATCH', { title: 'New title' }]);
      expect(cell(0, 0).querySelector('.value')!.textContent!.trim()).toBe('New title'); // right away
      request.flush(row('a', 'New title'));
      await stable();
      expect(document.activeElement).toBe(cell(1, 0));
    });

    it('Escape cancels without saving', async () => {
      await open([row('a', 'Keep')]);
      const input = await editTitle(0);
      input.value = 'Changed';
      await key(input, 'Escape');
      http.expectNone('/api/databases/db1/rows/a');
      expect(cell(0, 0).querySelector('.value')!.textContent!.trim()).toBe('Keep');
      expect(document.activeElement).toBe(cell(0, 0));
    });

    it('typing on a cell starts editing with that character; Tab saves and moves right', async () => {
      await open([row('a', 'x')]);
      cell(0, col('notes')).click();
      await stable();
      await key(cell(0, col('notes')), 'h');
      const input = editor(0, col('notes'));
      expect(input.value).toBe('h');
      input.value = 'hello';
      await key(input, 'Tab');
      expect(patch('a').request.body).toEqual({ properties: { notes: 'hello' } });
      expect(document.activeElement).toBe(cell(0, col('points')));
    });

    it('numbers must be numbers', async () => {
      await open([row('a', 'x')]);
      cell(0, col('points')).click();
      await stable();
      await key(cell(0, col('points')), 'Enter');
      const input = editor(0, col('points'));
      input.value = 'lots';
      await key(input, 'Enter');
      http.expectNone('/api/databases/db1/rows/a');
      expect(cell(0, col('points')).querySelector('[role="alert"]')!.textContent).toContain('enter a number');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      input.value = '12.5';
      await key(input, 'Enter');
      patch('a').flush(row('a', 'x', { points: 12.5 }));
      await stable();
      expect(cell(0, col('points')).textContent!.trim()).toBe('12.5');
    });

    it('select, status and date use their own editors', async () => {
      await open([row('a', 'x')]);
      for (const [id, value, expected] of [
        ['priority', 'high', 'high'],
        ['state', 'done', 'done'],
      ] as const) {
        cell(0, col(id)).click();
        await stable();
        await key(cell(0, col(id)), 'Enter');
        const select = editor(0, col(id));
        expect(select.tagName).toBe('SELECT');
        select.value = value;
        select.dispatchEvent(new Event('change'));
        await stable();
        const request = patch('a');
        expect(request.request.body).toEqual({ properties: { [id]: expected } });
        request.flush(row('a', 'x', { [id]: expected }));
        await stable();
      }
      cell(0, col('due')).click();
      await stable();
      await key(cell(0, col('due')), 'Enter');
      const date = editor(0, col('due'));
      expect(date.type).toBe('date');
      date.value = '2026-12-24';
      await key(date, 'Enter');
      expect(patch('a').request.body).toEqual({ properties: { due: { start: '2026-12-24', end: null } } });
    });

    it('multi-select and person cells pick several, saving each change', async () => {
      await open([row('a', 'x', { tags: ['api'] })]);
      cell(0, col('tags')).click();
      await stable();
      await key(cell(0, col('tags')), 'Enter');
      const boxes = cell(0, col('tags')).querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(Array.from(boxes).map((b) => b.checked)).toEqual([true, false]);
      boxes[1].click();
      await stable();
      const request = patch('a');
      expect(request.request.body).toEqual({ properties: { tags: ['api', 'web'] } });
      request.flush(row('a', 'x', { tags: ['api', 'web'] }));
      await stable();
      cell(0, col('tags')).querySelector<HTMLButtonElement>('.done')!.click();
      await stable();
      expect(cell(0, col('tags')).textContent).toContain('APIWeb');

      cell(0, col('owner')).click();
      await stable();
      await key(cell(0, col('owner')), 'Enter');
      const people = cell(0, col('owner')).querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(people).toHaveLength(2);
      people[1].click();
      await stable();
      expect(patch('a').request.body).toEqual({ properties: { owner: ['u-bob'] } });
    });

    it('Space toggles a checkbox; Delete clears a cell', async () => {
      await open([row('a', 'x', { notes: 'remove me' })]);
      cell(0, col('done')).click();
      await stable();
      await key(cell(0, col('done')), ' ');
      const toggled = patch('a');
      expect(toggled.request.body).toEqual({ properties: { done: true } });
      toggled.flush(row('a', 'x', { notes: 'remove me', done: true }));
      await stable();

      cell(0, col('notes')).click();
      await stable();
      await key(cell(0, col('notes')), 'Delete');
      const cleared = patch('a');
      expect(cleared.request.body).toEqual({ properties: { notes: null } });
      cleared.flush(row('a', 'x', { done: true }));
      await stable();
      expect(cell(0, col('notes')).textContent!.trim()).toBe('');
    });

    it('puts the old value back and says why when saving fails', async () => {
      await open([row('a', 'x', { notes: 'before' })]);
      cell(0, col('notes')).click();
      await stable();
      await key(cell(0, col('notes')), 'Enter');
      const input = editor(0, col('notes'));
      input.value = 'after';
      await key(input, 'Enter');
      patch('a').flush({ detail: 'Restore the database before changing it' }, { status: 409, statusText: 'Conflict' });
      await stable();
      expect(cell(0, col('notes')).textContent!.trim()).toBe('before');
      expect(element.querySelector('.alert')!.textContent).toContain('Restore the database before changing it');
    });
  });

  describe('rows and properties', () => {
    it('New adds a row and starts editing its title', async () => {
      await open([row('a', 'First')]);
      element.querySelector<HTMLButtonElement>('.new-row')!.click();
      await settle();
      const request = http.expectOne('/api/databases/db1/rows');
      expect([request.request.method, request.request.body]).toEqual(['POST', { title: '' }]);
      request.flush(row('b', ''));
      await stable();
      expect(renderedRows()).toHaveLength(2);
      expect(document.activeElement).toBe(editor(1, 0));
      expect(element.querySelector('[role="status"]')!.textContent).toContain('Row added');
    });

    function openMenu(name: string) {
      const button = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-header]')).find((b) =>
        b.getAttribute('aria-label')!.startsWith(name),
      )!;
      button.click();
      return button;
    }

    function schemaSaved(properties: Property[]) {
      const request = http.expectOne('/api/databases/db1/schema');
      expect(request.request.method).toBe('PUT');
      const sent = request.request.body.properties as Property[];
      request.flush(database(properties));
      return sent;
    }

    it('adds a property with a name and type', async () => {
      await open([row('a', 'x')]);
      element.querySelector<HTMLButtonElement>('[aria-label="Add a property"]')!.click();
      await stable();
      const panel = element.querySelector<HTMLElement>('[role="dialog"][aria-label="Add a property"]')!;
      expect(document.activeElement).toBe(panel.querySelector('input'));
      panel.querySelector<HTMLInputElement>('input')!.value = 'Estimate';
      const type = panel.querySelector<HTMLSelectElement>('select')!;
      type.value = 'number';
      panel.querySelector<HTMLButtonElement>('.primary')!.click();
      await settle();
      const sent = schemaSaved([...PROPERTIES, { id: 'est1', name: 'Estimate', type: 'number' }]);
      expect(sent.at(-1)).toEqual({ name: 'Estimate', type: 'number' }); // no id: the server picks one
      expect(sent.slice(0, -1).map((p) => p.id)).toEqual(PROPERTIES.map((p) => p.id));
      await stable();
      expect(headers()).toContain('Estimate');
      expect(element.querySelector('[aria-label="Add a property"][role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(element.querySelector('[data-header="add"]'));
    });

    it('renames a property from its menu', async () => {
      await open([row('a', 'x')]);
      openMenu('Notes');
      await stable();
      const name = element.querySelector<HTMLInputElement>('.panel input')!;
      expect(document.activeElement).toBe(name);
      name.value = 'Comments';
      await key(name, 'Enter');
      const sent = schemaSaved(PROPERTIES.map((p) => (p.id === 'notes' ? { ...p, name: 'Comments' } : p)));
      expect(sent.find((p) => p.id === 'notes')!.name).toBe('Comments');
      await stable();
      expect(headers()).toContain('Comments');
      expect(element.querySelector('.panel')).toBeNull(); // Enter saves and closes
      http.expectNone('/api/databases/db1/schema'); // the blur that follows doesn't save again
    });

    it('changes a property type after a warning, clearing its values', async () => {
      await open([row('a', 'x', { notes: '42' })]);
      openMenu('Notes');
      await stable();
      const type = element.querySelector<HTMLSelectElement>('.panel select')!;
      type.value = 'number';
      type.dispatchEvent(new Event('change'));
      await stable();
      expect(element.querySelector('.panel .warning')!.textContent).toContain("clears this column's values");
      http.expectNone('/api/databases/db1/schema'); // not until confirmed
      element.querySelector<HTMLButtonElement>('.panel .primary')!.click();
      await settle();
      const sent = schemaSaved(PROPERTIES.map((p) => (p.id === 'notes' ? { id: 'notes', name: 'Notes', type: 'number' } : p)));
      expect(sent.find((p) => p.id === 'notes')).toEqual({ id: 'notes', name: 'Notes', type: 'number' });
      await stable();
      expect(cell(0, col('notes')).textContent!.trim()).toBe('');
      expect(element.querySelector('.panel')).toBeNull();
    });

    it('Escape closes a menu and returns to its button', async () => {
      await open([row('a', 'x')]);
      const button = openMenu('Notes');
      await stable();
      await key(element.querySelector<HTMLInputElement>('.panel input')!, 'Escape');
      expect(element.querySelector('.panel')).toBeNull();
      expect(document.activeElement).toBe(button);
    });
  });

  describe('read-only (in the trash)', () => {
    it('shows rows but takes no edits', async () => {
      await open([row('a', 'x')], { readOnly: true });
      expect(element.querySelector('.new-row')).toBeNull();
      expect(grid().getAttribute('aria-readonly')).toBe('true');
      expect(element.querySelector<HTMLButtonElement>('[data-header="notes"]')!.disabled).toBe(true);
      cell(0, 0).click();
      await stable();
      await key(cell(0, 0), 'Enter');
      expect(editor(0, 0)).toBeNull();
      await key(cell(0, 0), 'Delete');
      http.expectNone('/api/databases/db1/rows/a');
    });
  });

  it('explains a database that fails to load, and retries', async () => {
    fixture = TestBed.createComponent(DatabaseView);
    element = fixture.nativeElement;
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/pages/p1/database').flush(null, { status: 500, statusText: 'Error' });
    await stable();
    expect(element.querySelector('[role="alert"]')!.textContent).toContain("Couldn't load this database");
    element.querySelector<HTMLButtonElement>('.link-button')!.click();
    await settle();
    http.expectOne('/api/pages/p1/database').flush(null, { status: 404, statusText: 'Not found' });
    await stable();
    expect(element.querySelector('[role="alert"]')!.textContent).toContain("can't be found");
  });
});
