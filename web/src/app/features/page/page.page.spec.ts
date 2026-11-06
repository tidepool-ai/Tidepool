import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { Editor, JSONContent } from '@tiptap/core';
import { settle } from '../../../testing/auth-testing';
import { FakeCollabServer, FakeConnection } from '../../../testing/collab-testing';
import { stripIds } from '../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../testing/prosemirror-jsdom';
import { AuthService } from '../../core/auth/auth.service';
import { COLLAB_CONNECTOR } from '../../core/collab/collab-connection';
import { FORM_POSTER } from '../../core/files/image-upload';
import { EditorComponent } from '../editor/editor';
import { PageTreeStore } from '../page-tree/page-tree.store';
import { PagePage } from './page.page';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

const page = (id: string, title: string, archived_at: string | null = null) => ({
  id,
  workspace_id: 'ws',
  parent_id: null,
  title,
  icon: null,
  archived_at,
});
const saved = (page_id: string, content: JSONContent | null = null) => ({
  page_id,
  content,
  updated_at: content ? '2026-11-04T12:00:00Z' : null,
});
const paragraph = (text: string, id = 'b1'): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] }],
});

/** One open page view, like a browser tab. */
interface Tab {
  fixture: ComponentFixture<PagePage>;
  element: HTMLElement;
  connection: () => FakeConnection;
  editor: () => Editor | null | undefined;
  status: () => string | undefined;
  textbox: () => HTMLElement | null;
}

describe('PagePage (live editing, T15)', () => {
  let http: HttpTestingController;
  let server: FakeCollabServer;
  const postForm = vi.fn().mockResolvedValue(undefined);
  const me = signal<{ id: string; email: string } | null>({ id: 'u-ada', email: 'ada@example.com' });

  async function stable(tab: Tab) {
    await settle();
    await tab.fixture.whenStable();
    await tick();
    tab.fixture.detectChanges();
    await tab.fixture.whenStable();
  }

  function makeTab(): Tab {
    const fixture = TestBed.createComponent(PagePage);
    const element: HTMLElement = fixture.nativeElement;
    return {
      fixture,
      element,
      connection: () => fixture.componentInstance.connection() as FakeConnection,
      editor: () =>
        (fixture.debugElement.query(By.directive(EditorComponent))?.componentInstance as EditorComponent | undefined)?.instance(),
      status: () => element.querySelector('.save-status')?.textContent?.trim(),
      textbox: () => element.querySelector<HTMLElement>('[role="textbox"]'),
    };
  }

  /** Open a page in a new tab and answer its two REST requests. */
  async function open(
    id: string,
    pageResponse: object | null,
    content: object | null = saved(id),
    status = 200,
  ): Promise<Tab> {
    const tab = makeTab();
    tab.fixture.componentRef.setInput('pageId', id);
    tab.fixture.detectChanges();
    await settle();
    const pageRequest = http.expectOne(`/api/pages/${id}`);
    const contentRequest = http.expectOne(`/api/pages/${id}/content`);
    if (status === 200) pageRequest.flush(pageResponse);
    else pageRequest.flush(null, { status, statusText: 'Error' });
    if (content) contentRequest.flush(content);
    else contentRequest.flush(null, { status: 500, statusText: 'Error' });
    await stable(tab);
    return tab;
  }

  const text = (tab: Tab) => tab.editor()?.getText() ?? null;

  beforeAll(() => stubLayoutForProseMirror());

  beforeEach(() => {
    server = new FakeCollabServer();
    me.set({ id: 'u-ada', email: 'ada@example.com' });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FORM_POSTER, useValue: postForm },
        { provide: COLLAB_CONNECTOR, useValue: server.connector },
        { provide: AuthService, useValue: { user: me } },
        provideRouter([]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Content is never saved over REST any more.
    http.expectNone((r) => r.method === 'PUT');
    http.verify();
  });

  describe('opening a page', () => {
    it('connects first, then shows the live document', async () => {
      server.holdSync = true;
      const tab = await open('p1', page('p1', 'Roadmap'));
      expect(tab.element.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!.value).toBe('Roadmap');
      expect(tab.status()).toBe('Connecting…');
      expect(tab.textbox()).toBeNull(); // nothing to type into until synced

      server.release();
      await stable(tab);
      expect(tab.textbox()).toBeTruthy();
      expect(tab.status()).toBe('Saved');
      const status = tab.element.querySelector('.save-status')!;
      expect([status.getAttribute('role'), status.getAttribute('aria-live')]).toEqual(['status', 'polite']);
    });

    it('copies content saved before live editing into the live document, once', async () => {
      const first = await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Hello again')));
      expect(first.textbox()!.textContent).toContain('Hello again');
      expect(server.text('p1')).toContain('Hello again');

      const second = await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Hello again')));
      expect(text(second)).toBe('Hello again');
      expect(server.text('p1').match(/Hello again/g)).toHaveLength(1);
    });

    it('keeps one copy when two tabs copy the old content at the same moment', async () => {
      // Both tabs find the live document blank and copy the old content before either copy arrives.
      server.holdDelivery = true;
      const one = await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Only once')));
      const two = await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Only once')));
      expect(one.connection().sent.length).toBeGreaterThan(0);
      expect(two.connection().sent.length).toBeGreaterThan(0);
      server.deliver();
      await stable(one);
      await stable(two);
      expect(text(one)).toBe('Only once');
      expect(text(two)).toBe('Only once');
      expect(server.text('p1').match(/Only once/g)).toHaveLength(1);
    });

    it('never copies the old content over a live document that already exists', async () => {
      const editorTab = await open('p1', page('p1', 'Notes'));
      editorTab.editor()!.commands.insertContent('Live text');
      await stable(editorTab);
      const later = await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Stale JSON')));
      expect(text(later)).toBe('Live text');
    });

    it('never shows an editor if the old content fails to load, so it is never lost', async () => {
      const tab = await open('p1', page('p1', 'Notes'), null);
      expect(tab.textbox()).toBeNull();
      expect(tab.element.querySelector('[role="alert"]')!.textContent).toContain("Couldn't load this page's content");

      tab.element.querySelector<HTMLButtonElement>('.link-button')!.click();
      await settle();
      http.expectOne('/api/pages/p1/content').flush(saved('p1', paragraph('Back')));
      await stable(tab);
      expect(tab.textbox()!.textContent).toContain('Back');
    });

    it('ignores content that belongs to another page', async () => {
      const tab = await open('p1', page('p1', 'Notes'), saved('other', paragraph('Wrong page')));
      expect(tab.textbox()).toBeNull();
    });

    it('explains a missing or inaccessible page', async () => {
      const tab = await open('nope', null, saved('nope'), 404);
      expect(tab.element.querySelector('h1')!.textContent).toContain('Page not found');
      expect(tab.textbox()).toBeNull();
    });

    it("says so when it can't connect, and opens once back online", async () => {
      server.holdSync = true;
      const tab = await open('p1', page('p1', 'Notes'));
      tab.connection().goOffline();
      await stable(tab);
      expect(tab.element.querySelector('.lead')!.textContent).toContain("Can't reach the server");

      tab.connection().goOnline();
      await stable(tab);
      expect(tab.textbox()).toBeTruthy();
    });

    it('explains when the server refuses the page', async () => {
      server.holdSync = true;
      const tab = await open('p1', page('p1', 'Notes'));
      tab.connection().close('No access to this page');
      await stable(tab);
      expect(tab.element.querySelector('[role="alert"]')!.textContent).toContain("You don't have access to this page any more.");
      expect(tab.textbox()).toBeNull();
    });
  });

  describe('database pages (T17)', () => {
    it('show the table instead of the editor, without a live document', async () => {
      const tab = await open('p1', { ...page('p1', 'Tasks'), is_database: true });
      expect(server.connections).toHaveLength(0); // nothing to edit live
      expect(tab.element.classList).toContain('wide'); // tables and boards get more room
      expect(tab.textbox()).toBeNull();
      expect(tab.element.querySelector('app-database-view')).toBeTruthy();
      expect(tab.element.querySelector<HTMLElement>('.status-bar')!.hidden).toBe(true);
      http.expectOne('/api/pages/p1/database').flush(null, { status: 404, statusText: 'Not found' });
      await stable(tab);
      expect(tab.element.querySelector('app-database-view [role="alert"]')!.textContent).toContain("can't be found");
    });
  });

  describe('database rows (T19)', () => {
    it('open as a full page show their properties, with a link to the database, above the editor', async () => {
      const tab = await open('r1', { ...page('r1', 'First'), database_id: 'db1' });
      await settle();
      http.expectOne('/api/databases/db1').flush({ id: 'db1', page_id: 'p1', title: 'Tasks', archived_at: null, properties: [{ id: 'title', name: 'Name', type: 'title' }, { id: 'notes', name: 'Notes', type: 'text' }], views: [] });
      http.expectOne('/api/databases/db1/rows/r1').flush({ id: 'r1', database_id: 'db1', title: 'First', icon: null, properties: { notes: 'hi' }, created_at: '', updated_at: '' });
      http.expectOne('/api/workspaces/ws/members').flush([]);
      await stable(tab);
      const link = tab.element.querySelector<HTMLAnchorElement>('app-row-properties .breadcrumb a')!;
      expect(link.textContent!.trim()).toBe('Tasks');
      expect(tab.element.querySelector<HTMLInputElement>('#row-prop-notes')!.value).toBe('hi');
      expect(tab.textbox()).toBeTruthy(); // the row's body is a live page like any other
    });
  });

  describe('two tabs', () => {
    it('edit the same page live, with nothing saved over REST', async () => {
      const a = await open('p1', page('p1', 'Notes'));
      const b = await open('p1', page('p1', 'Notes'));

      a.editor()!.commands.insertContent('Hello');
      await stable(b);
      expect(text(b)).toBe('Hello');

      b.editor()!.commands.insertContentAt(b.editor()!.state.doc.content.size - 1, ' world');
      await stable(a);
      expect(text(a)).toBe('Hello world');
      expect(server.text('p1')).toContain('Hello world');
      expect(a.status()).toBe('Saved');
    });

    it('carry on offline and merge both sides on reconnect', async () => {
      const a = await open('p1', page('p1', 'Notes'));
      const b = await open('p1', page('p1', 'Notes'));
      a.editor()!.commands.insertContent('Shared');
      await stable(b);

      a.connection().goOffline();
      await stable(a);
      expect(a.status()).toBe('Offline');
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);

      a.editor()!.commands.insertContentAt(1, 'A: ');
      b.editor()!.commands.insertContentAt(b.editor()!.state.doc.content.size - 1, ' (B)');
      await stable(a);
      expect(a.status()).toBe('Offline. Your edits will sync when you reconnect.');
      expect(text(b)).toBe('Shared (B)'); // A's edit hasn't arrived
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      expect(leaving.defaultPrevented).toBe(true); // edits only this tab has

      a.connection().goOnline();
      await stable(a);
      await stable(b);
      expect(text(a)).toBe('A: Shared (B)');
      expect(text(b)).toBe('A: Shared (B)');
      expect(a.status()).toBe('Saved');
      const afterwards = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(afterwards);
      expect(afterwards.defaultPrevented).toBe(false);
    });

    it('stop editing when the server stops taking edits', async () => {
      const tab = await open('p1', page('p1', 'Notes'));
      tab.connection().close('This page is read-only');
      await stable(tab);
      expect(tab.status()).toBe('This page is read-only now.');
      expect(tab.textbox()!.getAttribute('contenteditable')).toBe('false');
    });
  });

  describe('presence', () => {
    const avatars = (tab: Tab) => Array.from(tab.element.querySelectorAll<HTMLElement>('.avatar'));

    function visitor(id: string, name: string): FakeConnection {
      const connection = server.connector('p1') as FakeConnection;
      connection.awareness.setLocalStateField('user', { id, name });
      return connection;
    }

    it("shows who else is on the page, not the person's own other tabs", async () => {
      const tab = await open('p1', page('p1', 'Notes'));
      expect(tab.connection().awareness.getLocalState()!['user']).toEqual({ id: 'u-ada', name: 'ada@example.com' });
      await open('p1', page('p1', 'Notes')); // Ada's second tab
      await stable(tab);
      expect(avatars(tab)).toHaveLength(0);

      const grace = visitor('u-grace', 'grace.hopper@example.com');
      await tick();
      await stable(tab);
      const [avatar] = avatars(tab);
      expect(avatar.textContent).toContain('GH');
      expect(avatar.getAttribute('title')).toBe('grace.hopper@example.com');
      expect(avatar.querySelector('.visually-hidden')!.textContent).toBe('grace.hopper@example.com');
      expect(tab.element.querySelector('.avatars')!.getAttribute('aria-label')).toBe('Also here: 1 person');

      grace.destroy(); // closed the tab
      await stable(tab);
      expect(avatars(tab)).toHaveLength(0);
    });

    it('shows four avatars and a count for the rest', async () => {
      const tab = await open('p1', page('p1', 'Notes'));
      for (const name of ['ann', 'ben', 'cy', 'dee', 'eve', 'fay']) visitor(`u-${name}`, `${name}@example.com`);
      await tick();
      await stable(tab);
      const shown = avatars(tab);
      expect(shown).toHaveLength(5);
      expect(shown.at(-1)!.textContent).toContain('+2');
      expect(shown.at(-1)!.getAttribute('title')).toBe('eve@example.com, fay@example.com');
      expect(tab.element.querySelector('.avatars')!.getAttribute('aria-label')).toBe('Also here: 6 people');
    });
  });

  describe('switching and closing', () => {
    it("opens the next page's own live document and lets go of the last one", async () => {
      const tab = await open('p1', page('p1', 'One'));
      tab.editor()!.commands.insertContent('First page');
      await stable(tab);
      const first = tab.connection();

      tab.fixture.componentRef.setInput('pageId', 'p2');
      tab.fixture.detectChanges();
      await settle();
      http.expectOne('/api/pages/p2').flush(page('p2', 'Two'));
      http.expectOne('/api/pages/p2/content').flush(saved('p2'));
      await stable(tab);

      expect(first.destroyed).toBe(true);
      expect(tab.connection().pageId).toBe('p2');
      expect(text(tab)).toBe('');
      expect(server.text('p1')).toContain('First page');
    });

    it('disconnects when the page view closes', async () => {
      const tab = await open('p1', page('p1', 'Notes'));
      const connection = tab.connection();
      tab.fixture.destroy();
      expect(connection.destroyed).toBe(true);
    });
  });

  describe('trashed pages', () => {
    it('show a read-only snapshot and never send anything', async () => {
      const writer = await open('p1', page('p1', 'Old'));
      writer.editor()!.commands.insertContent('Kept live');
      await stable(writer);

      const tab = await open('p1', page('p1', 'Old', '2026-11-01T00:00:00Z'), saved('p1', paragraph('Old JSON')));
      expect(tab.element.querySelector('.banner')!.textContent).toContain('in the trash');
      expect(tab.textbox()!.getAttribute('contenteditable')).toBe('false');
      expect(text(tab)).toBe('Kept live');
      expect(tab.connection().sent).toEqual([]);
      expect(tab.connection().destroyed).toBe(true);
      expect(tab.status()).toBe('');
      expect(tab.element.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!.readOnly).toBe(true);
    });

    it('fall back to the old JSON when the page was never opened live', async () => {
      const tab = await open('p1', page('p1', 'Old', '2026-11-01T00:00:00Z'), saved('p1', paragraph('Only JSON')));
      expect(text(tab)).toBe('Only JSON');
      expect(server.text('p1')).toBe('');
    });
  });

  describe('images', () => {
    it('uploads a pasted image and adds it to the live document', async () => {
      const tab = await open('p1', page('p1', 'Photos'), saved('p1', paragraph('Hi')));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      const file = new File(['png'], 'shot.png', { type: 'image/png' });
      Object.defineProperty(event, 'clipboardData', { value: { files: [file], types: ['Files'], items: [], getData: () => '' } });
      tab.editor()!.view.dom.dispatchEvent(event);
      await tick();

      const presign = http.expectOne('/api/files/presign');
      expect(presign.request.body).toEqual({ page_id: 'p1', filename: 'shot.png', content_type: 'image/png', size: 3 });
      presign.flush({ upload_url: 'https://storage.example.com/b', fields: { key: 'k' }, url: '/api/files/pages/p1/k.png' });
      await stable(tab);
      await tick();
      expect(postForm).toHaveBeenCalledWith('https://storage.example.com/b', expect.any(FormData), expect.any(Function));
      expect(server.text('p1')).toContain('/api/files/pages/p1/k.png');
    });
  });

  describe('title', () => {
    it('saves a new title on Enter, updates the sidebar, and moves to the content', async () => {
      const applyTitle = vi.spyOn(TestBed.inject(PageTreeStore), 'applyTitle');
      const tab = await open('p1', page('p1', ''));
      const title = tab.element.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;

      title.value = '  Launch plan ';
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await settle();
      const request = http.expectOne((r) => r.method === 'PATCH');
      expect(stripIds(request.request.body)).toEqual({ title: 'Launch plan' });
      request.flush(page('p1', 'Launch plan'));
      await stable(tab);

      expect(applyTitle).toHaveBeenCalledWith('p1', 'Launch plan');
      await nextFrame(); // Tiptap moves focus on the next animation frame
      expect(document.activeElement).toBe(tab.textbox());
    });

    it('saves on blur, but not when the title did not change', async () => {
      const tab = await open('p1', page('p1', 'Same'));
      const title = tab.element.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;
      title.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectNone((r) => r.method === 'PATCH');

      title.value = 'Changed';
      title.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectOne((r) => r.method === 'PATCH').flush(page('p1', 'Changed'));
      await stable(tab);
    });

    it('puts the old title back and says so when saving fails', async () => {
      const tab = await open('p1', page('p1', 'Old'));
      const title = tab.element.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;
      title.value = 'New';
      title.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectOne((r) => r.method === 'PATCH').flush(null, { status: 409, statusText: 'Conflict' });
      await stable(tab);

      expect(title.value).toBe('Old');
      expect(tab.element.querySelector('#title-error')!.textContent).toContain("Couldn't save the title");
      expect(title.getAttribute('aria-describedby')).toBe('title-error');
    });
  });
});
