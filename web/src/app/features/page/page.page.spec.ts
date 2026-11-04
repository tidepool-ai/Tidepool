import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { stubLayoutForProseMirror } from '../../../testing/prosemirror-jsdom';
import { settle } from '../../../testing/auth-testing';
import { By } from '@angular/platform-browser';
import { EMPTY_DOC, EditorComponent } from '../editor/editor';
import { PageTreeStore } from '../page-tree/page-tree.store';
import { PagePage } from './page.page';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const page = (id: string, title: string, archived_at: string | null = null) => ({
  id,
  workspace_id: 'ws',
  parent_id: null,
  title,
  icon: null,
  archived_at,
});

describe('PagePage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PagePage>;
  let element: HTMLElement;

  async function stable() {
    await settle();
    await fixture.whenStable();
  }

  async function open(id: string, response: object | null, status = 200) {
    fixture.componentRef.setInput('pageId', id);
    fixture.detectChanges();
    await settle();
    const request = http.expectOne(`/api/pages/${id}`);
    if (status === 200) request.flush(response);
    else request.flush(null, { status, statusText: 'Error' });
    await stable();
  }

  const title = () => element.querySelector<HTMLInputElement>('input[aria-label="Page title"]');
  const textbox = () => element.querySelector<HTMLElement>('[role="textbox"]');

  beforeAll(() => stubLayoutForProseMirror());

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PagePage);
    element = fixture.nativeElement;
  });

  afterEach(() => http.verify());

  it('shows the page title and an empty editor', async () => {
    await open('p1', page('p1', 'Roadmap'));
    expect(title()!.value).toBe('Roadmap');
    expect(title()!.placeholder).toBe('Untitled');
    expect(textbox()).toBeTruthy();
    expect(fixture.componentInstance.content()).toEqual(EMPTY_DOC);
  });

  it('saves a new title on Enter, updates the sidebar, and moves to the content', async () => {
    const tree = TestBed.inject(PageTreeStore);
    const applyTitle = vi.spyOn(tree, 'applyTitle');
    await open('p1', page('p1', ''));

    title()!.value = '  Launch plan ';
    title()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    const request = http.expectOne('/api/pages/p1');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ title: 'Launch plan' });
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
    http.expectNone('/api/pages/p1');

    title()!.value = 'Changed';
    title()!.dispatchEvent(new FocusEvent('blur'));
    await settle();
    http.expectOne('/api/pages/p1').flush(page('p1', 'Changed'));
    await stable();
  });

  it('puts the old title back and says so when saving fails', async () => {
    await open('p1', page('p1', 'Old'));
    title()!.value = 'New';
    title()!.dispatchEvent(new FocusEvent('blur'));
    await settle();
    http.expectOne('/api/pages/p1').flush(null, { status: 409, statusText: 'Conflict' });
    await stable();

    expect(title()!.value).toBe('Old');
    const alert = element.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't save the title");
    expect(title()!.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('keeps the content as JSON while typing', async () => {
    await open('p1', page('p1', 'Notes'));
    const editor = fixture.debugElement.query(By.directive(EditorComponent)).componentInstance as EditorComponent;
    // Typing reaches the page through the editor's update event.
    editor.instance()!.commands.insertContent('Hi');
    await stable();
    expect(fixture.componentInstance.content()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    });
  });

  it('starts a fresh editor (and undo history) for another page', async () => {
    await open('p1', page('p1', 'One'));
    const first = textbox();
    await open('p2', page('p2', 'Two'));

    expect(title()!.value).toBe('Two');
    expect(textbox()).not.toBe(first);
    expect(fixture.componentInstance.content()).toEqual(EMPTY_DOC);
  });

  it('says when a page is in the trash', async () => {
    await open('p1', page('p1', 'Old', '2026-11-01T00:00:00Z'));
    expect(element.querySelector('[role="status"]')!.textContent).toContain('in the trash');
  });

  it('explains a missing or inaccessible page', async () => {
    await open('nope', null, 404);
    expect(element.querySelector('h1')!.textContent).toContain('Page not found');
    expect(textbox()).toBeNull();
  });
});
