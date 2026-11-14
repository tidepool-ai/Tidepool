import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { settle } from '../../../testing/auth-testing';
import { PageTreeStore } from '../page-tree/page-tree.store';
import { CommandBar, SEARCH_DELAY_MS, SearchResult } from './command-bar';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [CommandBar],
  template: `@if (open()) {
    <app-command-bar [currentPageId]="current()" (closed)="open.set(false)" />
  }`,
})
class Host {
  readonly open = signal(true);
  readonly current = signal<string | null>(null);
}

const WORKSPACE = 'ws';

function result(id: string, title: string, extra: Partial<SearchResult> = {}): SearchResult {
  return { id, title, icon: null, parent_id: null, updated_at: '2026-11-10T12:00:00Z', path: [], ...extra };
}

const RECENT = [
  result('roadmap', 'Roadmap'),
  result('tasks', 'Tasks', { is_database: true }),
  result('q1', 'Q1 goals', { parent_id: 'roadmap', path: ['Roadmap'] }),
];

describe('CommandBar (T22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Host>;
  let element: HTMLElement;
  let router: Router;

  async function stable() {
    await settle();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const searchRequest = (q: string): TestRequest =>
    http.expectOne((r) => r.url === `/api/workspaces/${WORKSPACE}/search` && r.params.get('q') === q);

  async function open(recent: SearchResult[] = RECENT, current: string | null = null) {
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement;
    document.body.appendChild(element);
    fixture.componentInstance.current.set(current);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    const request = searchRequest('');
    expect(request.request.params.get('limit')).toBe('20');
    request.flush(recent);
    await stable();
  }

  const input = () => element.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const options = () =>
    Array.from(element.querySelectorAll('[role="option"]')).map((o) => o.querySelector('.label')!.textContent!.trim());
  const active = () => element.querySelector('[role="option"][aria-selected="true"] .label')?.textContent?.trim();
  const key = async (k: string, extra: KeyboardEventInit = {}) => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    await stable();
  };
  async function type(text: string, results: SearchResult[]) {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));
    searchRequest(text).flush(results);
    await stable();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    // The sidebar has loaded the workspace.
    const tree = TestBed.inject(PageTreeStore);
    void tree.load();
    http.expectOne('/api/workspaces').flush([{ id: WORKSPACE, name: 'w' }]);
    return settle().then(() => http.expectOne(`/api/workspaces/${WORKSPACE}/pages`).flush([]));
  });
  afterEach(() => {
    http.verify();
    fixture?.destroy();
  });

  it('is a combobox dialog with focus in the input, showing recent pages when empty', async () => {
    await open();
    expect(element.querySelector('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-controls')).toBe('command-results');
    expect(element.querySelector('.group')!.textContent).toBe('Recent');
    expect(options()).toEqual(['Roadmap', 'Tasks', 'Q1 goals', 'New page', 'Create task']);
    expect(input().getAttribute('aria-activedescendant')).toBe('cmd-page-roadmap');
    expect(element.querySelector('#cmd-page-q1 .detail')!.textContent).toBe('Roadmap');
  });

  it('keyboard only: type, move with the arrows (wrapping) and open with Enter', async () => {
    await open();
    await type('goal', [result('q1', 'Q1 goals', { path: ['Roadmap'] }), result('q2', 'Q2 goals')]);
    expect(element.querySelector('.group')!.textContent).toBe('Pages');
    expect(options()).toEqual(['Q1 goals', 'Q2 goals', 'New page “goal”', 'Create task “goal”']);

    await key('ArrowDown');
    expect(active()).toBe('Q2 goals');
    expect(input().getAttribute('aria-activedescendant')).toBe('cmd-page-q2');
    await key('ArrowUp');
    await key('ArrowUp'); // wraps to the last
    expect(active()).toBe('Create task “goal”');
    await key('ArrowDown'); // and back to the first
    await key('ArrowDown');
    expect(active()).toBe('Q2 goals');

    await key('Enter');
    expect(router.url).toBe('/p/q2');
    expect(element.querySelector('app-command-bar')).toBeNull();
  });

  it('switches scope with Tab and Shift+Tab', async () => {
    await open();
    const selected = () => element.querySelector('[role="tab"][aria-selected="true"]')!.textContent!.trim();
    await key('Tab');
    expect(selected()).toBe('Pages');
    expect(options()).toEqual(['Roadmap', 'Tasks', 'Q1 goals']);
    await key('Tab');
    expect(selected()).toBe('Actions');
    expect(options()).toEqual(['New page', 'Create task']);
    await key('Tab', { shiftKey: true });
    await key('Tab', { shiftKey: true });
    expect(selected()).toBe('All');
    expect(document.activeElement).toBe(input());
  });

  it('creates a page with the typed title and opens it', async () => {
    await open();
    await type('Launch plan', []);
    expect(element.querySelector('.empty')).toBeNull();
    await key('Enter'); // the first item is the "New page" action
    const create = http.expectOne('/api/pages');
    expect(create.request.body).toEqual({ workspace_id: WORKSPACE, parent_id: null, title: 'Launch plan' });
    create.flush({ id: 'new', workspace_id: WORKSPACE, parent_id: null, title: 'Launch plan', icon: null });
    await stable();
    expect(router.url).toBe('/p/new');
    expect(TestBed.inject(PageTreeStore).renamingId()).toBeNull();
  });

  it('creates a task in the database being viewed and opens it in the side peek', async () => {
    await open(RECENT, 'tasks');
    await type('Write docs', []);
    await key('ArrowDown');
    expect(active()).toBe('Create task “Write docs”');
    expect(element.querySelector('#cmd-new-task .detail')!.textContent).toBe('In Tasks');
    await key('Enter');
    http.expectOne('/api/pages/tasks/database').flush({ id: 'db1' });
    await settle();
    const row = http.expectOne('/api/databases/db1/rows');
    expect(row.request.body).toEqual({ title: 'Write docs' });
    row.flush({ id: 'r9' });
    await stable();
    expect(router.url).toBe('/p/tasks?row=r9');
  });

  it("uses a row's database, and says when there is no database to add a task to", async () => {
    await open([result('r1', 'Old task', { database_id: 'db7', parent_id: 'board', path: ['Sprint'] })]);
    expect(element.querySelector('#cmd-new-task .detail')!.textContent).toBe('In Sprint');
    fixture.destroy();

    await open([result('notes', 'Notes')]);
    const task = element.querySelector('#cmd-new-task')!;
    expect(task.getAttribute('aria-disabled')).toBe('true');
    expect(task.querySelector('.detail')!.textContent).toBe('Open a database first');
    await key('End'); // not handled: the caret moves in the input
    await key('ArrowUp');
    await key('Enter');
    http.expectNone('/api/databases/db7/rows');
    expect(element.querySelector('app-command-bar')).not.toBeNull();
  });

  it('ignores a late answer to an older search', async () => {
    await open();
    input().value = 'ro';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));
    const older = searchRequest('ro');
    await type('roa', [result('roadmap', 'Roadmap')]);
    older.flush([result('rocket', 'Rocket')]);
    await stable();
    expect(options()).toEqual(['Roadmap', 'New page “roa”', 'Create task “roa”']);
  });

  it('says when nothing matches and when search fails', async () => {
    await open();
    await key('Tab'); // Pages only
    await type('zzz', []);
    expect(element.querySelector('.empty')!.textContent).toContain('No pages match “zzz”.');
    input().value = 'zz';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));
    searchRequest('zz').flush(null, { status: 500, statusText: 'Error' });
    await stable();
    expect(element.querySelector('.empty')!.textContent).toContain("Couldn't search");
  });

  it('closes with Escape or a click outside', async () => {
    await open();
    await key('Escape');
    expect(element.querySelector('app-command-bar')).toBeNull();

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    searchRequest('').flush(RECENT);
    await stable();
    element.querySelector<HTMLElement>('.backdrop')!.click();
    await stable();
    expect(element.querySelector('app-command-bar')).toBeNull();
  });
});
