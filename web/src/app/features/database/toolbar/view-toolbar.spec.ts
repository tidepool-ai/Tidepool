import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { settle } from '../../../../testing/auth-testing';
import { MEMBERS, PROPERTIES, database, page, row } from '../../../../testing/database-testing';
import { Database, DatabaseViewInfo, ViewConfig } from '../database.api';
import { DatabaseView } from '../database-view';
import { conditionText, isComplete, parseFilter, toFilter } from './filter';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const byId = new Map(PROPERTIES.map((p) => [p.id, p]));
const people = new Map(MEMBERS.map((m) => [m.user_id, m.email]));

describe('filter helpers (T20)', () => {
  it('reads saved filters and keeps nested ones as advanced', () => {
    expect(parseFilter(null)).toEqual({ mode: 'and', conditions: [], advanced: false });
    const one = { property: 'state', operator: 'is', value: 'done' };
    expect(parseFilter(one)).toEqual({ mode: 'and', conditions: [one], advanced: false });
    expect(parseFilter({ or: [one] })).toEqual({ mode: 'or', conditions: [one], advanced: false });
    expect(parseFilter({ and: [one, { or: [one] }] }).advanced).toBe(true);
  });

  it('writes filters the API takes', () => {
    expect(toFilter('and', [])).toBeNull();
    expect(toFilter('or', [{ property: 'notes', operator: 'is_empty', value: 'x' }])).toEqual({
      or: [{ property: 'notes', operator: 'is_empty' }],
    });
  });

  it('knows when a condition is ready to save', () => {
    expect(isComplete({ property: 'notes', operator: 'contains' })).toBe(false);
    expect(isComplete({ property: 'notes', operator: 'contains', value: '' })).toBe(false);
    expect(isComplete({ property: 'notes', operator: 'is_empty' })).toBe(true);
    expect(isComplete({ property: 'points', operator: 'equals', value: 0 })).toBe(true);
  });

  it('says each condition in words', () => {
    const text = (property: string, operator: string, value?: unknown) =>
      conditionText({ property, operator, value }, byId.get(property), people);
    expect(text('state', 'is_not', 'done')).toBe('Status is not Done');
    expect(text('due', 'before', '2026-11-05')).toBe('Due is before Nov 5, 2026');
    expect(text('tags', 'contains', 'api')).toBe('Tags includes API');
    expect(text('owner', 'contains', 'u-ada')).toBe('Owner includes ada@example.com');
    expect(text('points', 'greater_than_or_equal', 3)).toBe('Points is at least 3');
    expect(text('notes', 'contains', 'spec')).toBe('Notes contains “spec”');
    expect(text('notes', 'is_empty')).toBe('Notes is empty');
    expect(text('done', 'is', false)).toBe('Done is not checked');
  });
});

describe('Filters and sorts (T20)', () => {
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

  function view(id: string, config: ViewConfig = {}, extra: Partial<DatabaseViewInfo> = {}): DatabaseViewInfo {
    return { id, name: id === 'v1' ? 'Table' : 'Other', layout: 'table', config, position: id === 'v1' ? 0 : 1, ...extra };
  }

  async function open(db: Database = database(), readOnly = false) {
    fixture = TestBed.createComponent(DatabaseView);
    element = fixture.nativeElement;
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.componentRef.setInput('readOnly', readOnly);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/pages/p1/database').flush(db);
    await settle();
    http.expectOne('/api/databases/db1/query').flush(page([row('a', 'First')]));
    http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
  }

  const button = (label: string) =>
    Array.from(element.querySelectorAll<HTMLButtonElement>('app-view-toolbar button')).find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === label,
    )!;
  const click = async (target: HTMLElement) => {
    target.click();
    await stable();
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await stable();
  };
  const sortButton = () => element.querySelector<HTMLButtonElement>('.sort-button')!;
  const chips = () => Array.from(element.querySelectorAll('.filter-chip')).map((c) => c.textContent!.trim());
  const popover = () => element.querySelector<HTMLElement>('app-view-toolbar .popover');
  const select = (selector: string) => element.querySelector<HTMLSelectElement>(`app-view-toolbar ${selector}`)!;

  /** Answer the view's PATCH with what was sent, then the rows it reloads. */
  async function saved(viewId = 'v1'): Promise<TestRequest> {
    await settle();
    const request = http.expectOne((r) => r.method === 'PATCH' && r.url === `/api/databases/db1/views/${viewId}`);
    request.flush(view(viewId, request.request.body.config));
    await settle();
    const query = http.expectOne('/api/databases/db1/query');
    expect(query.request.body.view_id).toBe(viewId);
    query.flush(page([row('b', 'Matching')]));
    await stable();
    return request;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('adds a filter once it has a value, saves it to the view and reloads the rows', async () => {
    await open();
    await click(button('+ Filter'));
    const status = Array.from(element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) =>
      b.textContent!.includes('Status'),
    )!;
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    await click(status);

    expect(popover()?.getAttribute('aria-label')).toBe('Filter by Status');
    await choose(select('#filter-operator'), 'is_not');
    http.expectNone((r) => r.method === 'PATCH'); // no value yet
    await choose(select('#filter-value'), 'done');

    const request = await saved();
    expect(request.request.body.config).toEqual({
      filter: { and: [{ property: 'state', operator: 'is_not', value: 'done' }] },
    });
    expect(chips()).toEqual(['Status is not Done']);
    expect(element.querySelector('[role="grid"]')!.textContent).toContain('Matching');
  });

  it('saves filters with no value straight away, and text on Enter', async () => {
    await open();
    await click(button('+ Filter'));
    await click(Array.from(element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent!.includes('Done'))!);
    expect((await saved()).request.body.config.filter).toEqual({ and: [{ property: 'done', operator: 'is', value: true }] });

    await click(button('+ Filter'));
    await click(Array.from(element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent!.includes('Notes'))!);
    const input = element.querySelector<HTMLInputElement>('#filter-value')!;
    input.value = 'spec';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect((await saved()).request.body.config.filter.and[1]).toEqual({ property: 'notes', operator: 'contains', value: 'spec' });
    expect(chips()).toEqual(['Done is checked', 'Notes contains “spec”']);
    expect(popover()).toBeNull();
    expect(document.activeElement?.classList.contains('add-filter')).toBe(true);
  });

  it('edits, joins with "any" and removes filters', async () => {
    const filter = {
      and: [
        { property: 'state', operator: 'is', value: 'done' },
        { property: 'points', operator: 'greater_than', value: 2 },
      ],
    };
    await open(database(PROPERTIES, { views: [view('v1', { filter })] }));
    expect(chips()).toEqual(['Status is Done', 'Points is greater than 2']);

    await click(button('Filter: Points is greater than 2'));
    const input = element.querySelector<HTMLInputElement>('#filter-value')!;
    expect(document.activeElement).toBe(select('#filter-operator'));
    input.value = '5';
    input.dispatchEvent(new Event('change'));
    expect((await saved()).request.body.config.filter.and[1].value).toBe(5);

    await choose(select('#filter-mode'), 'or');
    expect((await saved()).request.body.config.filter).toEqual({
      or: [
        { property: 'state', operator: 'is', value: 'done' },
        { property: 'points', operator: 'greater_than', value: 5 },
      ],
    });

    await click(button('Remove filter: Status is Done'));
    expect((await saved()).request.body.config.filter).toEqual({
      or: [{ property: 'points', operator: 'greater_than', value: 5 }],
    });
    await click(button('Remove filter: Points is greater than 5'));
    expect((await saved()).request.body.config.filter).toBeNull();
    expect(chips()).toEqual([]);
  });

  it('adds, changes and removes sorts (up to five)', async () => {
    await open();
    await click(sortButton());
    expect(popover()?.textContent).toContain('No sorts');

    await click(button('+ Add a sort'));
    expect((await saved()).request.body.config.sorts).toEqual([{ property: 'title', direction: 'ascending' }]);
    expect(element.querySelector('.sort-button')!.textContent).toContain('Sorted by Name');

    await choose(element.querySelectorAll<HTMLSelectElement>('.sort-row select')[1], 'descending');
    expect((await saved()).request.body.config.sorts).toEqual([{ property: 'title', direction: 'descending' }]);
    await choose(element.querySelectorAll<HTMLSelectElement>('.sort-row select')[0], 'due');
    expect((await saved()).request.body.config.sorts).toEqual([{ property: 'due', direction: 'descending' }]);

    await click(button('+ Add a sort'));
    expect((await saved()).request.body.config.sorts).toEqual([
      { property: 'due', direction: 'descending' },
      { property: 'title', direction: 'ascending' },
    ]);
    expect(element.querySelector('.sort-button')!.textContent).toContain('2 sorts');
    // A sort row doesn't offer a property another row uses.
    const first = Array.from(element.querySelectorAll<HTMLSelectElement>('.sort-row select')[0].options).map((o) => o.value);
    expect(first).toContain('due');
    expect(first).not.toContain('title');

    await click(button('Remove sort by Due'));
    expect((await saved()).request.body.config.sorts).toEqual([{ property: 'title', direction: 'ascending' }]);
  });

  it("keeps each view's settings, and shows them again after a reload", async () => {
    const config: ViewConfig = {
      filter: { and: [{ property: 'tags', operator: 'contains', value: 'api' }] },
      sorts: [{ property: 'points', direction: 'descending' }],
    };
    const db = database(PROPERTIES, { views: [view('v1', config), view('v2')] });
    await open(db);
    expect(chips()).toEqual(['Tags includes API']);
    expect(element.querySelector('.sort-button')!.textContent).toContain('Sorted by Points');

    // The other view has its own (none).
    element.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
    await settle();
    expect(http.expectOne('/api/databases/db1/query').request.body.view_id).toBe('v2');
    await stable();
    expect(chips()).toEqual([]);
    expect(element.querySelector('.sort-button')!.textContent!.trim()).toContain('Sort');

    // Reload: the page loads the saved views again and shows the same chips.
    fixture.destroy();
    await open(db);
    expect(chips()).toEqual(['Tags includes API']);
  });

  it('shows why a change was refused and keeps the old filter', async () => {
    await open();
    await click(button('+ Filter'));
    await click(Array.from(element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent!.includes('Done'))!);
    await settle();
    http
      .expectOne((r) => r.method === 'PATCH')
      .flush({ detail: 'This database is in the trash' }, { status: 409, statusText: 'Conflict' });
    await stable();
    expect(element.querySelector('app-view-toolbar [role="alert"]')!.textContent).toContain('This database is in the trash');
    expect(chips()).toEqual([]);
  });

  it('closes popovers with Escape and returns focus, without closing anything else', async () => {
    await open();
    await click(sortButton());
    const panel = popover()!;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await stable();
    expect(popover()).toBeNull();
    expect(document.activeElement?.classList.contains('sort-button')).toBe(true);
  });

  it('only shows the settings on a read-only database', async () => {
    const config: ViewConfig = { filter: { property: 'state', operator: 'is', value: 'done' }, sorts: [] };
    await open(database(PROPERTIES, { views: [view('v1', config)] }), true);
    expect(chips()).toEqual(['Status is Done']);
    expect(element.querySelector('app-view-toolbar button')).toBeNull();
  });
});
