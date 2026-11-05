import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { JSONContent } from '@tiptap/core';
import { settle } from '../../../testing/auth-testing';
import { stripIds } from '../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../testing/prosemirror-jsdom';
import { EMPTY_DOC, EditorComponent } from '../editor/editor';
import { PageTreeStore } from '../page-tree/page-tree.store';
import { FORM_POSTER } from '../../core/files/image-upload';
import { AUTOSAVE_DELAY_MS, PagePage } from './page.page';

const DELAY = 20;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
const paragraph = (text: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('PagePage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PagePage>;
  let element: HTMLElement;

  async function stable() {
    await settle();
    await fixture.whenStable();
  }

  async function open(id: string, pageResponse: object | null, content: object | null = saved(id), status = 200) {
    fixture.componentRef.setInput('pageId', id);
    fixture.detectChanges();
    await settle();
    const pageRequest = http.expectOne(`/api/pages/${id}`);
    const contentRequest = http.expectOne(`/api/pages/${id}/content`);
    if (status === 200) pageRequest.flush(pageResponse);
    else pageRequest.flush(null, { status, statusText: 'Error' });
    if (content) contentRequest.flush(content);
    else contentRequest.flush(null, { status: 500, statusText: 'Error' });
    await stable();
  }

  const title = () => element.querySelector<HTMLInputElement>('input[aria-label="Page title"]');
  const textbox = () => element.querySelector<HTMLElement>('[role="textbox"]');
  const saveStatus = () => element.querySelector('.save-status')?.textContent?.trim();
  const editor = () =>
    (fixture.debugElement.query(By.directive(EditorComponent))?.componentInstance as EditorComponent | undefined)?.instance();

  /** Type into the editor and wait past the autosave delay; returns the PUT request. */
  async function typeAndWait(text: string, pageId = 'p1') {
    editor()!.commands.insertContent(text);
    await stable();
    expect(saveStatus()).toBe('Saving…');
    await wait(DELAY + 10);
    return http.expectOne((r) => r.method === 'PUT' && r.url === `/api/pages/${pageId}/content`);
  }

  const postForm = vi.fn().mockResolvedValue(undefined);

  beforeAll(() => stubLayoutForProseMirror());

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AUTOSAVE_DELAY_MS, useValue: DELAY },
        { provide: FORM_POSTER, useValue: postForm },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PagePage);
    element = fixture.nativeElement;
  });

  afterEach(() => http.verify());

  it('uses a 1 second autosave delay by default', () => {
    TestBed.resetTestingModule();
    expect(TestBed.inject(AUTOSAVE_DELAY_MS)).toBe(1000);
  });

  describe('loading', () => {
    it('shows the title and an empty editor for a page that was never saved', async () => {
      await open('p1', page('p1', 'Roadmap'));
      expect(title()!.value).toBe('Roadmap');
      expect(textbox()).toBeTruthy();
      expect(editor()!.getText()).toBe('');
      expect(saveStatus()).toBe('');
    });

    it('restores saved content into the editor, and loading is not an edit', async () => {
      const withIds = { type: 'doc', content: [{ ...paragraph('Hello again').content![0], attrs: { id: 'b1' } }] };
      await open('p1', page('p1', 'Notes'), saved('p1', withIds));
      expect(textbox()!.textContent).toContain('Hello again');
      await wait(DELAY + 20);
      http.expectNone((r) => r.method === 'PUT');
    });

    it('saves block ids once for content saved before blocks had them', async () => {
      await open('p1', page('p1', 'Notes'), saved('p1', paragraph('Old page')));
      await wait(DELAY + 20);
      const save = http.expectOne((r) => r.method === 'PUT');
      expect(save.request.body.content.content[0].attrs.id).toBeTruthy();
      save.flush(saved('p1'));
      await stable();
    });

    it('never shows an editor if the content fails to load, so nothing gets overwritten', async () => {
      await open('p1', page('p1', 'Notes'), null);
      expect(textbox()).toBeNull();
      expect(element.querySelector('[role="alert"]')!.textContent).toContain("Couldn't load this page's content");

      element.querySelector<HTMLButtonElement>('.link-button')!.click();
      await settle();
      http.expectOne('/api/pages/p1/content').flush(saved('p1', paragraph('Back')));
      await stable();
      expect(textbox()!.textContent).toContain('Back');
    });

    it('ignores content that belongs to another page', async () => {
      await open('p1', page('p1', 'Notes'), saved('other', paragraph('Wrong page')));
      expect(textbox()).toBeNull();
    });

    it('explains a missing or inaccessible page', async () => {
      await open('nope', null, saved('nope'), 404);
      expect(element.querySelector('h1')!.textContent).toContain('Page not found');
      expect(textbox()).toBeNull();
    });
  });

  describe('autosave', () => {
    it('saves the document as JSON after a pause and shows "Saved"', async () => {
      await open('p1', page('p1', 'Notes'));
      const request = await typeAndWait('Hi');

      expect(stripIds(request.request.body)).toEqual({ content: paragraph('Hi') });
      request.flush(saved('p1', paragraph('Hi')));
      await stable();
      expect(saveStatus()).toBe('Saved');
      expect(stripIds(fixture.componentInstance.content())).toEqual(paragraph('Hi'));
    });

    it('announces the save state politely to screen readers', async () => {
      await open('p1', page('p1', 'Notes'));
      const status = element.querySelector('.save-status')!;
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('says when saving failed and retries on request', async () => {
      await open('p1', page('p1', 'Notes'));
      (await typeAndWait('Hi')).flush(null, { status: 500, statusText: 'Error' });
      await stable();
      expect(saveStatus()).toBe("Couldn't save");

      element.querySelector<HTMLButtonElement>('.status-bar .link-button')!.click();
      await settle();
      const retry = http.expectOne((r) => r.method === 'PUT');
      expect(stripIds(retry.request.body)).toEqual({ content: paragraph('Hi') });
      retry.flush(saved('p1', paragraph('Hi')));
      await stable();
      expect(saveStatus()).toBe('Saved');
    });

    it('says when a page is too large to save', async () => {
      await open('p1', page('p1', 'Notes'));
      (await typeAndWait('Hi')).flush({ detail: 'too big' }, { status: 413, statusText: 'Content Too Large' });
      await stable();
      expect(saveStatus()).toBe('Too large to save');
    });

    it('saves pending edits to the page they were typed on when switching pages', async () => {
      await open('p1', page('p1', 'One'));
      editor()!.commands.insertContent('Unsaved');
      await stable();

      fixture.componentRef.setInput('pageId', 'p2');
      fixture.detectChanges();
      await settle();
      const flushed = http.expectOne((r) => r.method === 'PUT');
      expect(flushed.request.url).toBe('/api/pages/p1/content');
      expect(stripIds(flushed.request.body)).toEqual({ content: paragraph('Unsaved') });
      flushed.flush(saved('p1', paragraph('Unsaved')));
      http.expectOne('/api/pages/p2').flush(page('p2', 'Two'));
      http.expectOne('/api/pages/p2/content').flush(saved('p2'));
      await stable();

      expect(title()!.value).toBe('Two');
      expect(editor()!.getText()).toBe('');
      expect(saveStatus()).toBe('');
    });

    it('asks before leaving with unsaved edits, and saves them', async () => {
      await open('p1', page('p1', 'Notes'));
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);

      editor()!.commands.insertContent('Unsaved');
      await stable();
      const dirty = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(dirty);
      expect(dirty.defaultPrevented).toBe(true);
      await settle();
      http.expectOne((r) => r.method === 'PUT').flush(saved('p1', paragraph('Unsaved')));
      await stable();
    });

    it('saves what is left when the page view closes', async () => {
      await open('p1', page('p1', 'Notes'));
      editor()!.commands.insertContent('Bye');
      await stable();
      fixture.destroy();
      await settle();
      http.expectOne((r) => r.method === 'PUT' && r.url === '/api/pages/p1/content');
    });
  });

  describe('images', () => {
    it("uploads a pasted image to this page's storage and saves the page with it", async () => {
      await open('p1', page('p1', 'Photos'), saved('p1', { type: 'doc', content: [{ ...paragraph('Hi').content![0], attrs: { id: 'b1' } }] }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      const file = new File(['png'], 'shot.png', { type: 'image/png' });
      Object.defineProperty(event, 'clipboardData', { value: { files: [file], types: ['Files'], items: [], getData: () => '' } });
      editor()!.view.dom.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve));

      const presign = http.expectOne('/api/files/presign');
      expect(presign.request.body).toEqual({ page_id: 'p1', filename: 'shot.png', content_type: 'image/png', size: 3 });
      presign.flush({ upload_url: 'https://storage.example.com/b', fields: { key: 'k' }, url: '/api/files/pages/p1/k.png' });
      await stable();
      await new Promise((resolve) => setTimeout(resolve));
      expect(postForm).toHaveBeenCalledWith('https://storage.example.com/b', expect.any(FormData), expect.any(Function));

      await wait(DELAY + 20);
      const save = http.expectOne((r) => r.method === 'PUT');
      expect(save.request.body.content.content.map((n: JSONContent) => n.type)).toContain('image');
      save.flush(saved('p1'));
      await stable();
    });
  });

  describe('trashed pages', () => {
    it('shows the content read-only, with a banner, and never tries to save it', async () => {
      await open('p1', page('p1', 'Old', '2026-11-01T00:00:00Z'), saved('p1', paragraph('Kept')));
      await wait(DELAY + 20);
      http.expectNone((r) => r.method === 'PUT');
      expect(element.querySelector('.banner')!.textContent).toContain('in the trash');
      expect(textbox()!.getAttribute('contenteditable')).toBe('false');
      expect(title()!.readOnly).toBe(true);
    });
  });

  describe('title', () => {
    it('saves a new title on Enter, updates the sidebar, and moves to the content', async () => {
      const applyTitle = vi.spyOn(TestBed.inject(PageTreeStore), 'applyTitle');
      await open('p1', page('p1', ''));

      title()!.value = '  Launch plan ';
      title()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await settle();
      const request = http.expectOne((r) => r.method === 'PATCH');
      expect(stripIds(request.request.body)).toEqual({ title: 'Launch plan' });
      request.flush(page('p1', 'Launch plan'));
      await stable();

      expect(applyTitle).toHaveBeenCalledWith('p1', 'Launch plan');
      await nextFrame(); // Tiptap moves focus on the next animation frame
      expect(document.activeElement).toBe(textbox());
    });

    it('saves on blur, but not when the title did not change', async () => {
      await open('p1', page('p1', 'Same'));
      title()!.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectNone((r) => r.method === 'PATCH');

      title()!.value = 'Changed';
      title()!.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectOne((r) => r.method === 'PATCH').flush(page('p1', 'Changed'));
      await stable();
    });

    it('puts the old title back and says so when saving fails', async () => {
      await open('p1', page('p1', 'Old'));
      title()!.value = 'New';
      title()!.dispatchEvent(new FocusEvent('blur'));
      await settle();
      http.expectOne((r) => r.method === 'PATCH').flush(null, { status: 409, statusText: 'Conflict' });
      await stable();

      expect(title()!.value).toBe('Old');
      const alert = element.querySelector('#title-error')!;
      expect(alert.textContent).toContain("Couldn't save the title");
      expect(title()!.getAttribute('aria-describedby')).toBe('title-error');
    });
  });

  it('starts from an empty document for a new page', async () => {
    await open('p1', page('p1', 'One'));
    expect(stripIds(fixture.componentInstance.content())).toEqual(EMPTY_DOC);
  });
});
