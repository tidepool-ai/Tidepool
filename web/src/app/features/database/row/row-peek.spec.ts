import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { settle } from '../../../../testing/auth-testing';
import { FakeCollabServer } from '../../../../testing/collab-testing';
import { MEMBERS, PROPERTIES, database, page, row } from '../../../../testing/database-testing';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { AuthService } from '../../../core/auth/auth.service';
import { COLLAB_CONNECTOR } from '../../../core/collab/collab-connection';
import { Database, Row } from '../database.api';
import { PagePage } from '../../page/page.page';

const ROWS: Row[] = [row('r1', 'First', { notes: 'one' }), row('r2', 'Second')];
const BOARD_DB: Database = database(PROPERTIES, {
  views: [{ id: 'vb', name: 'Board', layout: 'board', config: { group_by: 'state' }, position: 0 }],
});

describe('Row side peek (T19)', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let router: Router;

  /** Let rendering, routing and requests settle. (Not whenStable: it waits for unanswered requests.) */
  async function stable() {
    for (let i = 0; i < 3; i++) {
      await settle();
      harness.detectChanges();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  const element = () => harness.routeNativeElement!;
  const peek = () => element().querySelector<HTMLElement>('app-row-peek [role="dialog"]');

  /** Open the database page at `url` and answer the database's requests. */
  async function open(url = '/p/p1', db: Database = database()) {
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
    await harness.navigateByUrl(url);
    await settle();
    // The database's own page...
    http.expectOne('/api/pages/p1').flush({ id: 'p1', workspace_id: 'ws', parent_id: null, title: 'Tasks', icon: null, archived_at: null, is_database: true });
    http.expectOne('/api/pages/p1/content').flush({ page_id: 'p1', content: null, updated_at: null });
    await stable();
    // ...and its database.
    (await next('/api/pages/p1/database')).flush(db);
    await settle();
    http.expectOne('/api/databases/db1/query').flush(page(ROWS));
    http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
  }

  /** The next request to `url`, once it's been sent (the peek loads on demand). */
  async function next(url: string) {
    for (let i = 0; i < 20; i++) {
      const [request] = http.match(url);
      if (request) return request;
      await stable();
    }
    return http.expectOne(url);
  }

  /** The peek's row page loads: the page, its old content, and its properties. */
  async function answerRowPage(rowId: string, title: string) {
    (await next(`/api/pages/${rowId}`)).flush({ id: rowId, workspace_id: 'ws', parent_id: 'p1', title, icon: null, archived_at: null, database_id: 'db1' });
    (await next(`/api/pages/${rowId}/content`)).flush({ page_id: rowId, content: null, updated_at: null });
    (await next('/api/databases/db1')).flush(database());
    (await next(`/api/databases/db1/rows/${rowId}`)).flush(ROWS.find((r) => r.id === rowId)!);
    (await next('/api/workspaces/ws/members')).flush(MEMBERS);
    await stable();
  }

  const escape = (target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  beforeAll(() => stubLayoutForProseMirror());

  beforeEach(() => {
    const collab = new FakeCollabServer();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'p/:pageId', component: PagePage }], withComponentInputBinding()),
        { provide: COLLAB_CONNECTOR, useValue: collab.connector },
        { provide: AuthService, useValue: { user: signal({ id: 'u-ada', email: 'ada@example.com' }) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("opens a row from the table's Open button, and the URL says which", async () => {
    await open();
    const openButton = element().querySelector<HTMLButtonElement>('[aria-label="Open First"]')!;
    openButton.focus();
    openButton.click();
    await stable();
    expect(router.url).toBe('/p/p1?row=r1');
    await answerRowPage('r1', 'First');

    expect(peek()!.getAttribute('aria-label')).toBe('Row: First');
    expect(document.activeElement).toBe(peek());
    // Properties on top, the editor below.
    const body = peek()!.querySelector('app-page-page')!;
    expect(body.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!.value).toBe('First');
    expect(body.querySelector<HTMLInputElement>('#row-prop-notes')!.value).toBe('one');
    expect(body.querySelector('[role="textbox"]')).toBeTruthy();
    const order = Array.from(body.querySelectorAll('app-row-properties, [role="textbox"]')).map((e) => e.tagName);
    expect(order[0]).toBe('APP-ROW-PROPERTIES');
    expect(body.querySelector('.breadcrumb')).toBeNull(); // the table is right there
    expect(peek()!.querySelector('a.open-full')!.getAttribute('href')).toBe('/p/r1');
  });

  it('Esc closes the peek, takes ?row off the URL, and returns focus', async () => {
    await open();
    const openButton = element().querySelector<HTMLButtonElement>('[aria-label="Open Second"]')!;
    openButton.focus();
    openButton.click();
    await stable();
    await answerRowPage('r2', 'Second');
    expect(peek()).toBeTruthy();

    escape(peek()!);
    await stable();
    expect(peek()).toBeNull();
    expect(router.url).toBe('/p/p1');
    expect(document.activeElement).toBe(openButton);
  });

  it('Esc in the editor closes the peek (the editor itself has no use for it)', async () => {
    await open('/p/p1?row=r1');
    await answerRowPage('r1', 'First');
    const editor = peek()!.querySelector<HTMLElement>('[role="textbox"]')!;
    editor.focus();
    escape(editor);
    await stable();
    expect(peek()).toBeNull();
    expect(router.url).toBe('/p/p1');
  });

  it('Esc goes to an open menu inside the peek first; Close closes it', async () => {
    await open('/p/p1?row=r1');
    await answerRowPage('r1', 'First');
    // A menu is open in the peek (e.g. the block menu): Esc is for it.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    peek()!.querySelector('.body')!.append(menu);
    escape(menu);
    await stable();
    expect(peek()).toBeTruthy();
    menu.remove();

    // Esc that the table or board used (outside the peek) doesn't close it either.
    const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    used.preventDefault();
    document.body.dispatchEvent(used);
    await stable();
    expect(peek()).toBeTruthy();

    peek()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    await stable();
    expect(peek()).toBeNull();
    expect(router.url).toBe('/p/p1');
  });

  it('a link with ?row= opens straight into the peek', async () => {
    await open('/p/p1?row=r2');
    expect(peek()).toBeTruthy();
    await answerRowPage('r2', 'Second');
    expect(peek()!.getAttribute('aria-label')).toBe('Row: Second');
  });

  it('Shift+Enter on a cell opens its row', async () => {
    await open();
    const cell = element().querySelector<HTMLElement>('[data-cell="1:1"]')!;
    cell.click();
    await stable();
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await stable();
    expect(router.url).toBe('/p/p1?row=r2');
    await answerRowPage('r2', 'Second');
    expect(element().querySelector('[data-cell="0:0"]')!.getAttribute('aria-describedby')).toBe('open-row-help');
  });

  it('changes made in the peek show in the table at once', async () => {
    await open('/p/p1?row=r1');
    await answerRowPage('r1', 'First');
    const notes = peek()!.querySelector<HTMLInputElement>('#row-prop-notes')!;
    notes.value = 'changed';
    notes.dispatchEvent(new Event('blur'));
    await settle();
    http.expectOne('/api/databases/db1/rows/r1').flush(row('r1', 'First', { notes: 'changed' }));
    await stable();
    expect(element().querySelector('[data-cell="0:1"]')!.textContent!.trim()).toBe('changed');

    const title = peek()!.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;
    title.value = 'Renamed';
    title.dispatchEvent(new FocusEvent('blur'));
    await settle();
    http.expectOne((r) => r.method === 'PATCH' && r.url === '/api/pages/r1').flush({ id: 'r1', workspace_id: 'ws', parent_id: 'p1', title: 'Renamed', icon: null, archived_at: null, database_id: 'db1' });
    await stable();
    expect(element().querySelector('[data-cell="0:0"] .value')!.textContent!.trim()).toBe('Renamed');
    expect(peek()!.getAttribute('aria-label')).toBe('Row: Renamed');
  });

  it('board cards open on click or Enter', async () => {
    await open('/p/p1', BOARD_DB);
    const card = element().querySelector<HTMLElement>('[data-card="r2"]')!;
    card.click();
    await stable();
    expect(router.url).toBe('/p/p1?row=r2');
    await answerRowPage('r2', 'Second');
    escape();
    await stable();
    element().querySelector<HTMLElement>('[data-card="r1"]')!.focus();
    element().querySelector<HTMLElement>('[data-card="r1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await stable();
    expect(router.url).toBe('/p/p1?row=r1');
    await answerRowPage('r1', 'First');
  });
});
