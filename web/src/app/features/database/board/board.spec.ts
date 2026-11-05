import { CdkDropList } from '@angular/cdk/drag-drop';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { settle } from '../../../../testing/auth-testing';
import { MEMBERS, PROPERTIES, database, page, row, rows } from '../../../../testing/database-testing';
import { Database, DatabaseViewInfo, Row } from '../database.api';
import { DatabaseView } from '../database-view';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const BOARD: DatabaseViewInfo = { id: 'vb', name: 'Board', layout: 'board', config: { group_by: 'state' }, position: 1 };
const TABLE: DatabaseViewInfo = { id: 'v1', name: 'Table', layout: 'table', config: {}, position: 0 };

/** Board shown first: views [Board, Table]. */
function boardDb(extra: Partial<Database> = {}): Database {
  return database(PROPERTIES, { views: [BOARD, TABLE], ...extra });
}

const CARDS: Row[] = [
  row('a', 'Write spec', { state: 'not-started' }),
  row('b', 'Ship it', { state: 'done' }),
  row('c', 'Untriaged'),
  row('d', 'Plan', { state: 'not-started' }),
];

describe('Board lens (T18)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<DatabaseView>;
  let element: HTMLElement;

  async function stable() {
    await settle();
    await fixture.whenStable();
    await frame();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function open(results: Row[] = CARDS, options: { db?: Database; cursor?: string | null; readOnly?: boolean } = {}) {
    fixture = TestBed.createComponent(DatabaseView);
    element = fixture.nativeElement;
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.componentRef.setInput('readOnly', options.readOnly ?? false);
    fixture.detectChanges();
    await settle();
    const db = options.db ?? boardDb();
    http.expectOne('/api/pages/p1/database').flush(db);
    await settle();
    const query = http.expectOne('/api/databases/db1/query');
    expect(query.request.body.view_id).toBe(db.views[0].id);
    query.flush(page(results, options.cursor ?? null));
    http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
  }

  const columns = () => Array.from(element.querySelectorAll<HTMLElement>('.column'));
  const summary = () =>
    columns().map((c) => [
      c.querySelector('.column-title .chip')!.textContent!.trim(),
      c.querySelector('.count')!.textContent!.trim(),
      Array.from(c.querySelectorAll('.card')).map((card) => card.textContent!.trim()),
    ]);
  const card = (id: string) => element.querySelector<HTMLElement>(`[data-card="${id}"]`)!;
  const status = () => element.querySelector('app-database-board [role="status"]')!.textContent!.trim();
  const key = async (target: HTMLElement, k: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await stable();
  };
  const patch = (id: string): TestRequest => http.expectOne(`/api/databases/db1/rows/${id}`);

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('has a column per option, one for no value, and counts', async () => {
    await open();
    expect(summary()).toEqual([
      ['No Status', '1', ['Untriaged']],
      ['Not started', '2', ['Write spec', 'Plan']],
      ['Done', '1', ['Ship it']],
    ]);
    expect(columns()[1].querySelector('.count')!.getAttribute('aria-label')).toBe('2 cards');
    expect(columns()[2].querySelector('.count')!.getAttribute('aria-label')).toBe('1 card');
    expect(card('a').getAttribute('aria-label')).toBe('Write spec, in Not started');
    expect(columns()[1].querySelector('ul')!.getAttribute('aria-label')).toBe('Not started');
  });

  it('loads every card, not just the first page', async () => {
    await open(rows(100), { cursor: 'c1' });
    const more = http.expectOne('/api/databases/db1/query');
    expect(more.request.body).toEqual({ view_id: 'vb', page_size: 100, cursor: 'c1' });
    more.flush(page(rows(30, 100)));
    await stable();
    expect(columns()[0].querySelector('.count')!.textContent!.trim()).toBe('130'); // all without a status
  });

  describe('drag and drop', () => {
    const lists = () => fixture.debugElement.queryAll(By.directive(CdkDropList));

    function drop(cardRow: Row, fromIndex: number, toIndex: number) {
      const from = lists()[fromIndex].injector.get(CdkDropList);
      const to = lists()[toIndex];
      to.triggerEventHandler('cdkDropListDropped', {
        previousContainer: from,
        container: to.injector.get(CdkDropList),
        item: { data: cardRow },
        previousIndex: 0,
        currentIndex: 0,
      });
    }

    it('dropping a card on another column changes its property', async () => {
      await open();
      drop(CARDS[0], 1, 2); // Write spec: Not started → Done
      await stable();
      const request = patch('a');
      expect([request.request.method, request.request.body]).toEqual(['PATCH', { properties: { state: 'done' } }]);
      expect(summary()[2]).toEqual(['Done', '2', ['Write spec', 'Ship it']]); // moved right away, in the view's order
      request.flush(row('a', 'Write spec', { state: 'done' }));
      await stable();
      expect(status()).toBe('Moved Write spec to Done.');
    });

    it('dropping on "No Status" clears the property; dropping in the same column does nothing', async () => {
      await open();
      drop(CARDS[1], 2, 0);
      await stable();
      expect(patch('b').request.body).toEqual({ properties: { state: null } });
      drop(CARDS[0], 1, 1);
      await stable();
      http.expectNone('/api/databases/db1/rows/a');
    });

    it('puts the card back if the move is refused', async () => {
      await open();
      drop(CARDS[0], 1, 2);
      await stable();
      patch('a').flush({ detail: 'Restore the database before changing it' }, { status: 409, statusText: 'Conflict' });
      await stable();
      expect(summary()[1][2]).toContain('Write spec');
    });
  });

  describe('keyboard', () => {
    it('Space picks a card up, arrows choose the column, Space drops it there', async () => {
      await open();
      card('a').focus();
      await key(card('a'), ' ');
      expect(card('a').classList).toContain('lifted');
      expect(card('a').getAttribute('aria-grabbed')).toBe('true');
      expect(status()).toContain('Picked up Write spec in Not started');

      await key(card('a'), 'ArrowRight');
      expect(summary()[2][2]).toContain('Write spec'); // shown over Done while lifted
      expect(status()).toContain('over Done');
      expect(document.activeElement).toBe(card('a'));
      await key(card('a'), 'ArrowRight'); // no column further right
      http.expectNone('/api/databases/db1/rows/a');

      await key(card('a'), ' ');
      expect(patch('a').request.body).toEqual({ properties: { state: 'done' } });
      expect(card('a').classList).not.toContain('lifted');
      expect(document.activeElement).toBe(card('a'));
      expect(status()).toBe('Moved Write spec to Done.');
    });

    it('Escape puts the card back without saving', async () => {
      await open();
      card('b').focus();
      await key(card('b'), ' ');
      await key(card('b'), 'ArrowLeft');
      await key(card('b'), 'ArrowLeft');
      expect(summary()[0][2]).toContain('Ship it');
      await key(card('b'), 'Escape');
      expect(summary()[2]).toEqual(['Done', '1', ['Ship it']]);
      expect(status()).toBe('Ship it put back in Done.');
      http.expectNone('/api/databases/db1/rows/b');
    });

    it('moves a card to "No Status" by keyboard', async () => {
      await open();
      card('d').focus();
      await key(card('d'), ' ');
      await key(card('d'), 'ArrowLeft');
      await key(card('d'), 'Enter');
      expect(patch('d').request.body).toEqual({ properties: { state: null } });
    });

    it('arrows move between cards when nothing is picked up', async () => {
      await open();
      card('a').focus();
      await key(card('a'), 'ArrowDown');
      expect(document.activeElement).toBe(card('d'));
      await key(card('d'), 'ArrowRight');
      expect(document.activeElement).toBe(card('b')); // nearest card in the next column
      await key(card('b'), 'ArrowLeft');
      await key(document.activeElement as HTMLElement, 'ArrowLeft');
      expect(document.activeElement).toBe(card('c'));
    });
  });

  it('adds a card to a column, with that column\'s value, and names it', async () => {
    await open();
    columns()[2].querySelector<HTMLButtonElement>('.new-card')!.click();
    await settle();
    const created = http.expectOne('/api/databases/db1/rows');
    expect(created.request.body).toEqual({ title: '', properties: { state: 'done' } });
    created.flush(row('n', '', { state: 'done' }));
    await stable();
    const input = card('n').querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    input.value = 'Celebrate';
    await key(input, 'Enter');
    expect(patch('n').request.body).toEqual({ title: 'Celebrate' });
    expect(summary()[2]).toEqual(['Done', '2', ['Ship it', 'Celebrate']]);
  });

  it('groups by another status or select property', async () => {
    await open();
    const select = element.querySelector<HTMLSelectElement>('.group-by select')!;
    expect(Array.from(select.options).map((o) => o.textContent!.trim())).toEqual(['Priority', 'Status']);
    select.value = 'priority';
    select.dispatchEvent(new Event('change'));
    await settle();
    const request = http.expectOne('/api/databases/db1/views/vb');
    expect([request.request.method, request.request.body]).toEqual(['PATCH', { config: { group_by: 'priority' } }]);
    request.flush({ ...BOARD, config: { group_by: 'priority' } });
    await stable();
    expect(summary().map((c) => c[0])).toEqual(['No Priority', 'High', 'Low']);
  });

  it('is read-only in the trash', async () => {
    await open(CARDS, { readOnly: true });
    expect(element.querySelector('.new-card')).toBeNull();
    card('a').focus();
    await key(card('a'), ' ');
    expect(card('a').classList).not.toContain('lifted');
    expect(element.querySelector<HTMLSelectElement>('.group-by select')!.disabled).toBe(true);
  });

  describe('views', () => {
    it('shows views as tabs; switching fetches that view\'s rows', async () => {
      await open(CARDS, { db: database(PROPERTIES, { views: [TABLE, BOARD] }) });
      const tabs = () => Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]'));
      expect(tabs().map((t) => [t.textContent!.trim(), t.getAttribute('aria-selected')])).toEqual([
        ['Table', 'true'],
        ['Board', 'false'],
      ]);
      expect(element.querySelector('app-database-table')).toBeTruthy();

      tabs()[0].focus();
      await key(tabs()[0], 'ArrowRight');
      const query = http.expectOne('/api/databases/db1/query');
      expect(query.request.body.view_id).toBe('vb');
      query.flush(page(CARDS));
      await stable();
      expect(element.querySelector('app-database-board')).toBeTruthy();
      expect(document.activeElement).toBe(tabs()[1]);
      expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    });

    it('adds a board view grouped by the first status or select property', async () => {
      await open(CARDS, { db: database() });
      element.querySelector<HTMLButtonElement>('.add-view')!.click();
      await stable();
      element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1].click();
      await settle();
      const created = http.expectOne('/api/databases/db1/views');
      expect(created.request.body).toEqual({ name: 'Board', layout: 'board', config: { group_by: 'priority' } });
      created.flush({ ...BOARD, config: { group_by: 'priority' } });
      await settle();
      http.expectOne('/api/databases/db1/query').flush(page(CARDS));
      await stable();
      expect(element.querySelector('[role="tab"][aria-selected="true"]')!.textContent!.trim()).toBe('Board');
      expect(summary().map((c) => c[0])).toEqual(['No Priority', 'High', 'Low']);
    });

    it('explains that a board needs a status or select property', async () => {
      const plain = database([PROPERTIES[0], PROPERTIES[1]]);
      await open([row('a', 'x')], { db: plain });
      element.querySelector<HTMLButtonElement>('.add-view')!.click();
      await stable();
      element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1].click();
      await stable();
      http.expectNone('/api/databases/db1/views');
      expect(element.querySelector('.alert')!.textContent).toContain('needs a Status or Select property');
    });
  });
});
