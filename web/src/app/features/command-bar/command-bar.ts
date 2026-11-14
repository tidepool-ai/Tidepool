import { A11yModule } from '@angular/cdk/a11y';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PageTreeStore } from '../page-tree/page-tree.store';

/** A page from GET /api/workspaces/{id}/search (T22). */
export interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  parent_id: string | null;
  database_id?: string | null;
  is_database?: boolean;
  updated_at: string;
  access?: string;
  /** Titles of the pages above it the person can open, top first. */
  path: string[];
}

type Scope = 'all' | 'pages' | 'actions';

interface Item {
  id: string;
  kind: 'page' | 'action';
  label: string;
  detail: string;
  disabled?: boolean;
  page?: SearchResult;
  run?: () => Promise<void>;
}

export const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pages', label: 'Pages' },
  { value: 'actions', label: 'Actions' },
];

/** Wait this long after typing before searching. */
export const SEARCH_DELAY_MS = 150;

const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Cmd/Ctrl+K (FR-27): recent pages when empty, title search as you type, and actions (new page,
 * create task). A combobox: focus stays in the input, arrows move the highlight, Enter opens it,
 * Tab / Shift+Tab switch scope, Escape closes.
 */
@Component({
  selector: 'app-command-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule],
  templateUrl: './command-bar.html',
  styleUrl: './command-bar.scss',
  host: { '(click)': 'backdropClick($event)' },
})
export class CommandBar {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly tree = inject(PageTreeStore);

  /** The page open behind the bar, if any: tasks go into it when it's a database (or a row of one). */
  readonly currentPageId = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly SCOPES = SCOPES;
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected readonly query = signal('');
  protected readonly scope = signal<Scope>('all');
  protected readonly results = signal<SearchResult[]>([]);
  /** Recent pages (what the bar shows when empty), also used to pick where tasks go. */
  private readonly recent = signal<SearchResult[]>([]);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly active = signal(0);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private searches = 0;

  /** Where "Create task" adds a row: the open database, else the most recently opened one. */
  private readonly taskTarget = computed(() => {
    const candidates = [...this.results(), ...this.recent()];
    const current = this.currentPageId();
    const isTarget = (page: SearchResult) => page.is_database || !!page.database_id;
    const open = current ? candidates.find((p) => p.id === current && isTarget(p)) : undefined;
    return open ?? this.recent().find(isTarget) ?? null;
  });

  protected readonly items = computed((): Item[] => {
    const text = this.query().trim();
    const pages: Item[] = this.results().map((page) => ({
      id: `cmd-page-${page.id}`,
      kind: 'page',
      label: page.title || 'Untitled',
      detail: page.path.join(' / '),
      page,
    }));
    const target = this.taskTarget();
    const actions: Item[] = [
      {
        id: 'cmd-new-page',
        kind: 'action',
        label: text ? `New page “${text}”` : 'New page',
        detail: 'Add a page at the top of the sidebar',
        run: () => this.newPage(text),
      },
      {
        id: 'cmd-new-task',
        kind: 'action',
        label: text ? `Create task “${text}”` : 'Create task',
        detail: target ? `In ${this.databaseTitle(target)}` : 'Open a database first',
        disabled: !target,
        run: () => this.createTask(text),
      },
    ];
    switch (this.scope()) {
      case 'pages':
        return pages;
      case 'actions':
        return actions;
      default:
        return [...pages, ...actions];
    }
  });
  protected readonly activeItem = computed(() => this.items()[this.active()] ?? null);
  protected readonly heading = computed(() => (this.query().trim() ? 'Pages' : 'Recent'));

  constructor() {
    afterNextRender(() => this.input().nativeElement.focus());
    // Search (or list recent pages) when the text changes, a moment after typing stops.
    effect((onCleanup) => {
      const text = this.query().trim();
      const delay = text ? SEARCH_DELAY_MS : 0;
      const timer = setTimeout(() => untracked(() => void this.search(text)), delay);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async search(text: string): Promise<void> {
    const workspaceId = this.tree.workspaceId();
    if (!workspaceId) return;
    const search = ++this.searches;
    this.loading.set(true);
    try {
      const results = await firstValueFrom(
        this.http.get<SearchResult[]>(`/api/workspaces/${workspaceId}/search`, { params: { q: text, limit: 20 } }),
      );
      if (search !== this.searches) return; // an older search finishing late
      this.results.set(results);
      if (!text) this.recent.set(results);
      this.failed.set(false);
      this.active.set(0);
    } catch {
      if (search === this.searches) this.failed.set(true);
    } finally {
      if (search === this.searches) this.loading.set(false);
    }
  }

  protected setQuery(text: string): void {
    this.query.set(text);
    this.error.set(null);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.items().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!count) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.active.set((this.active() + step + count) % count);
        this.scrollActiveIntoView();
        return;
      }
      case 'Enter': {
        event.preventDefault();
        const item = this.activeItem();
        if (item) void this.choose(item);
        return;
      }
      case 'Tab': {
        event.preventDefault();
        const index = SCOPES.findIndex((s) => s.value === this.scope());
        const next = (index + (event.shiftKey ? -1 : 1) + SCOPES.length) % SCOPES.length;
        this.setScope(SCOPES[next].value);
        return;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.closed.emit();
        return;
    }
  }

  protected setScope(scope: Scope): void {
    this.scope.set(scope);
    this.active.set(0);
    this.input().nativeElement.focus();
  }

  protected hover(index: number): void {
    this.active.set(index);
  }

  protected async choose(item: Item): Promise<void> {
    if (item.disabled || this.busy()) return;
    if (item.page) {
      this.closed.emit();
      await this.router.navigate(['/p', item.page.id]);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await item.run?.();
    } finally {
      this.busy.set(false);
    }
  }

  private async newPage(title: string): Promise<void> {
    const page = await this.tree.create(null, 'page', title);
    if (!page) {
      this.error.set("Couldn't create the page");
      return;
    }
    this.closed.emit();
    await this.router.navigate(['/p', page.id]);
  }

  /** Add a row to the target database and open it in the database's side peek. */
  private async createTask(title: string): Promise<void> {
    const target = this.taskTarget();
    if (!target) return;
    try {
      const databasePageId = target.is_database ? target.id : target.parent_id!;
      const databaseId =
        target.database_id ??
        (await firstValueFrom(this.http.get<{ id: string }>(`/api/pages/${databasePageId}/database`))).id;
      const row = await firstValueFrom(
        this.http.post<{ id: string }>(`/api/databases/${databaseId}/rows`, { title: title || '' }),
      );
      this.closed.emit();
      await this.router.navigate(['/p', databasePageId], { queryParams: { row: row.id } });
    } catch {
      this.error.set("Couldn't create the task");
    }
  }

  private databaseTitle(page: SearchResult): string {
    if (page.is_database) return page.title || 'Untitled';
    return page.path.at(-1) ?? 'its database';
  }

  protected edited(page: SearchResult): string {
    return `Edited ${dateFormat.format(new Date(page.updated_at))}`;
  }

  private scrollActiveIntoView(): void {
    queueMicrotask(() => {
      const id = this.activeItem()?.id;
      const option = id ? document.getElementById(id) : null;
      option?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  /** A click outside the bar closes it. */
  protected backdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('backdrop')) this.closed.emit();
  }
}
