import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { settle } from '../../../testing/auth-testing';
import { PageTree } from './page-tree';
import { ApiPage, PageTreeStore } from './page-tree.store';

@Component({ template: '' })
class Blank {}

const WORKSPACE = 'ws-1';

function apiPage(id: string, title: string, parent: string | null = null, icon: string | null = null): ApiPage {
  return { id, workspace_id: WORKSPACE, parent_id: parent, title, icon };
}

describe('PageTree', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PageTree>;
  let tree: HTMLElement;

  async function render(topLevel: ApiPage[] = [apiPage('docs', 'Docs', null, '📚'), apiPage('notes', '')]) {
    fixture = TestBed.createComponent(PageTree);
    tree = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/workspaces').flush([{ id: WORKSPACE, name: "ada's workspace" }]);
    await settle();
    http.expectOne(`/api/workspaces/${WORKSPACE}/pages`).flush(topLevel);
    await stable();
  }

  async function stable() {
    await settle();
    await fixture.whenStable();
  }

  const button = (label: string) => {
    const element = tree.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!element) throw new Error(`no button "${label}" in: ${tree.innerHTML}`);
    return element;
  };
  const links = () => Array.from(tree.querySelectorAll<HTMLAnchorElement>('a.title:not([hidden])'));
  // The icon is aria-hidden, so a link's accessible name is its .text span.
  const nameOf = (a: Element) => a.querySelector('.text')!.textContent!.trim();
  const titles = () => links().map(nameOf);
  const link = (title: string) => links().find((a) => nameOf(a) === title)!;
  const titleInput = () => tree.querySelector<HTMLInputElement>('input[aria-label="Page title"]');
  const status = () => tree.querySelector('[role="status"]')!.textContent!.trim();

  async function type(value: string, key: 'Enter' | 'Escape') {
    const field = titleInput()!;
    field.value = value;
    field.dispatchEvent(new KeyboardEvent('keydown', { key }));
    await stable();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'home', component: Blank },
          { path: 'p/:pageId', component: Blank },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.inject(PageTreeStore).reset();
  });

  it('shows the top-level pages of the first workspace, with untitled pages named', async () => {
    await render();
    expect(titles()).toEqual(['Docs', 'Untitled']);
    expect(link('Docs').getAttribute('href')).toBe('/p/docs');
    expect(link('Docs').querySelector('.emoji')?.textContent).toBe('📚');
  });

  it('shows an empty state and a retry when loading fails', async () => {
    await render([]);
    expect(tree.textContent).toContain('No pages yet');

    TestBed.inject(PageTreeStore).reset();
    fixture.destroy();
    fixture = TestBed.createComponent(PageTree);
    tree = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/workspaces').flush(null, { status: 500, statusText: 'Error' });
    await stable();
    expect(tree.textContent).toContain("Couldn't load your pages");

    tree.querySelector<HTMLButtonElement>('.link-button')!.click();
    http.expectOne('/api/workspaces').flush([{ id: WORKSPACE, name: 'w' }]);
    await settle();
    http.expectOne(`/api/workspaces/${WORKSPACE}/pages`).flush([apiPage('a', 'Again')]);
    await stable();
    expect(titles()).toEqual(['Again']);
  });

  describe('expand and collapse', () => {
    it('loads children the first time a page is expanded, one level only', async () => {
      await render();
      const toggle = button('Expand Docs');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      toggle.click();
      await stable();
      expect(tree.textContent).toContain('Loading…');
      http.expectOne('/api/pages/docs/children').flush([apiPage('guides', 'Guides', 'docs')]);
      await stable();

      expect(button('Collapse Docs').getAttribute('aria-expanded')).toBe('true');
      expect(titles()).toEqual(['Docs', 'Guides', 'Untitled']);
      expect(button('Expand Guides')).toBeTruthy(); // grandchildren aren't fetched yet
    });

    it('collapses and re-expands without fetching again', async () => {
      await render();
      button('Expand Docs').click();
      http.expectOne('/api/pages/docs/children').flush([apiPage('guides', 'Guides', 'docs')]);
      await stable();

      button('Collapse Docs').click();
      await stable();
      expect(titles()).not.toContain('Guides');

      button('Expand Docs').click();
      await stable();
      http.expectNone('/api/pages/docs/children');
      expect(titles()).toContain('Guides');
    });

    it('says when a page has no subpages', async () => {
      await render();
      button('Expand Untitled').click();
      http.expectOne('/api/pages/notes/children').flush([]);
      await stable();
      expect(tree.textContent).toContain('No pages inside');
    });

    it('collapses again and reports it when children fail to load', async () => {
      await render();
      button('Expand Docs').click();
      http.expectOne('/api/pages/docs/children').flush(null, { status: 500, statusText: 'Error' });
      await stable();
      expect(button('Expand Docs').getAttribute('aria-expanded')).toBe('false');
      expect(status()).toContain("Couldn't load subpages");
    });
  });

  describe('create', () => {
    it('creates a top-level page and starts renaming it', async () => {
      await render();
      button('Add a page').click();
      const request = http.expectOne('/api/pages');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ workspace_id: WORKSPACE, parent_id: null });
      request.flush(apiPage('new', ''));
      await stable();

      expect(titleInput()).toBeTruthy();
      expect(document.activeElement).toBe(titleInput());
      await type('Roadmap', 'Enter');
      const rename = http.expectOne('/api/pages/new');
      expect(rename.request.method).toBe('PATCH');
      expect(rename.request.body).toEqual({ title: 'Roadmap' });
      rename.flush(apiPage('new', 'Roadmap'));
      await stable();

      expect(titles()).toEqual(['Docs', 'Untitled', 'Roadmap']);
      expect(document.activeElement).toBe(link('Roadmap'));
    });

    it('creates a database, shown with a table icon and no subpages', async () => {
      await render();
      button('Add a database').click();
      const request = http.expectOne('/api/databases');
      expect([request.request.method, request.request.body]).toEqual(['POST', { workspace_id: WORKSPACE, parent_id: null }]);
      request.flush({ id: 'db1', page_id: 'tasks', title: '', archived_at: null, properties: [], views: [] });
      await stable();
      expect(document.activeElement).toBe(titleInput()); // named right away, like a page
      expect(tree.querySelector('[role="status"]')!.textContent).toContain('Database created');
      await type('Tasks', 'Enter');
      http.expectOne('/api/pages/tasks').flush({ ...apiPage('tasks', 'Tasks'), is_database: true });
      await stable();

      const item = link('Tasks').closest('.row')!;
      expect(item.querySelector('.database-icon')).toBeTruthy();
      expect(item.querySelector('[aria-label="Expand Tasks"]')).toBeNull();
      expect(item.querySelector('[aria-label="Add a page inside Tasks"]')).toBeNull();
      expect(link('Docs').closest('.row')!.querySelector('[aria-label="Add a page inside Docs"]')).toBeTruthy();
    });

    it('shows databases loaded with the tree as databases', async () => {
      await render([{ ...apiPage('tasks', 'Tasks'), is_database: true }]);
      expect(link('Tasks').closest('.row')!.querySelector('.database-icon')).toBeTruthy();
    });

    it('creates a subpage and expands its parent to show it', async () => {
      await render();
      button('Add a page inside Docs').click();
      const request = http.expectOne('/api/pages');
      expect(request.request.body).toEqual({ workspace_id: WORKSPACE, parent_id: 'docs' });
      request.flush(apiPage('child', '', 'docs'));
      await stable();
      // The parent wasn't loaded yet, so expanding it fetches the full list (including the new page).
      http.expectOne('/api/pages/docs/children').flush([apiPage('guides', 'Guides', 'docs'), apiPage('child', '', 'docs')]);
      await stable();

      expect(button('Collapse Docs').getAttribute('aria-expanded')).toBe('true');
      expect(titleInput()).toBeTruthy();
      await type('', 'Escape');
      expect(titles()).toEqual(['Docs', 'Guides', 'Untitled', 'Untitled']);
    });

    it('reports a failed create', async () => {
      await render();
      button('Add a page').click();
      http.expectOne('/api/pages').flush(null, { status: 500, statusText: 'Error' });
      await stable();
      expect(status()).toContain("Couldn't create the page");
      expect(titleInput()).toBeNull();
    });
  });

  describe('rename', () => {
    it('renames inline with the Rename button', async () => {
      await render();
      button('Rename Docs').click();
      await stable();
      expect(titleInput()!.value).toBe('Docs');

      await type('Documentation', 'Enter');
      http.expectOne('/api/pages/docs').flush(apiPage('docs', 'Documentation'));
      await stable();
      expect(titles()[0]).toBe('Documentation');
      expect(status()).toContain('Renamed to Documentation');
    });

    it('starts renaming with F2 on the focused page link', async () => {
      await render();
      link('Docs').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
      await stable();
      expect(document.activeElement).toBe(titleInput());
    });

    it('cancels with Escape and does not save an unchanged title', async () => {
      await render();
      button('Rename Docs').click();
      await stable();
      await type('Something else', 'Escape');
      expect(titles()[0]).toBe('Docs');
      expect(document.activeElement).toBe(link('Docs'));

      button('Rename Docs').click();
      await stable();
      await type('Docs', 'Enter');
      http.expectNone('/api/pages/docs');
    });

    it('saves once when Enter is followed by blur', async () => {
      await render();
      button('Rename Docs').click();
      await stable();
      const field = titleInput()!;
      field.value = 'Docs 2';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      field.dispatchEvent(new FocusEvent('blur'));
      await stable();
      expect(http.match('/api/pages/docs')).toHaveLength(1);
    });

    it('puts the old title back if the server refuses', async () => {
      await render();
      button('Rename Docs').click();
      await stable();
      await type('Nope', 'Enter');
      expect(titles()[0]).toBe('Nope'); // shown right away
      http.expectOne('/api/pages/docs').flush(null, { status: 409, statusText: 'Conflict' });
      await stable();
      expect(titles()[0]).toBe('Docs');
      expect(status()).toContain("Couldn't rename");
    });
  });

  describe('trash', () => {
    it('moves a page to the trash and removes it from the tree', async () => {
      await render();
      button('Move Docs to trash').click();
      const request = http.expectOne('/api/pages/docs');
      expect(request.request.method).toBe('DELETE');
      request.flush(apiPage('docs', 'Docs'));
      await stable();

      expect(titles()).toEqual(['Untitled']);
      expect(status()).toContain('Moved Docs to the trash');
      expect(document.activeElement).toBe(button('Add a page'));
    });

    it('leaves the page that was open (or its parent) and goes home', async () => {
      await render();
      button('Expand Docs').click();
      http.expectOne('/api/pages/docs/children').flush([apiPage('guides', 'Guides', 'docs')]);
      await stable();
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/p/guides');

      button('Move Docs to trash').click();
      http.expectOne('/api/pages/docs').flush(apiPage('docs', 'Docs'));
      await stable();
      expect(router.url).toBe('/home');
    });

    it('moves focus to the parent page after trashing a subpage', async () => {
      await render();
      button('Expand Docs').click();
      http.expectOne('/api/pages/docs/children').flush([apiPage('guides', 'Guides', 'docs')]);
      await stable();

      button('Move Guides to trash').click();
      http.expectOne('/api/pages/guides').flush(apiPage('guides', 'Guides', 'docs'));
      await stable();
      expect(titles()).toEqual(['Docs', 'Untitled']);
      expect(document.activeElement).toBe(link('Docs'));
    });

    it('keeps the page when the server refuses', async () => {
      await render();
      button('Move Docs to trash').click();
      http.expectOne('/api/pages/docs').flush(null, { status: 404, statusText: 'Not Found' });
      await stable();
      expect(titles()).toContain('Docs');
      expect(status()).toContain("Couldn't move");
    });
  });

  it('highlights the open page', async () => {
    await render();
    await TestBed.inject(Router).navigateByUrl('/p/docs');
    await stable();

    expect(link('Docs').getAttribute('aria-current')).toBe('page');
    expect(link('Docs').closest('.row')!.classList).toContain('active');
    expect(link('Untitled').hasAttribute('aria-current')).toBe(false);
  });

  it('is operable by keyboard: every control is a native, named button or link in row order', async () => {
    await render();
    const row = link('Docs').closest('.row')!;
    const controls = Array.from(row.querySelectorAll<HTMLElement>('a[href], button'));
    expect(controls.map((c) => c.getAttribute('aria-label') ?? nameOf(c))).toEqual([
      'Expand Docs',
      'Docs',
      'Rename Docs',
      'Add a page inside Docs',
      'Move Docs to trash',
    ]);
    for (const control of tree.querySelectorAll<HTMLElement>('button')) {
      expect(control.getAttribute('type')).toBe('button');
    }
  });
});
