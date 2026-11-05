import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { JSONContent } from '@tiptap/core';
import { firstValueFrom } from 'rxjs';
import { EMPTY_DOC, EditorComponent } from '../editor/editor';
import { ApiPage, PageTreeStore } from '../page-tree/page-tree.store';
import { Autosave } from './autosave';

interface PageDetail extends ApiPage {
  archived_at: string | null;
}

interface PageContent {
  page_id: string;
  content: JSONContent | null;
  updated_at: string | null;
}

/** How long typing has to pause before the content is saved (T09: 1 second). */
export const AUTOSAVE_DELAY_MS = new InjectionToken<number>('AUTOSAVE_DELAY_MS', { factory: () => 1000 });

/** /p/:pageId: the page title and its content in the block editor, saved as you type. */
@Component({
  selector: 'app-page-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditorComponent],
  styleUrl: './page.page.scss',
  templateUrl: './page.page.html',
  host: { '(window:beforeunload)': 'warnIfUnsaved($event)' },
})
export class PagePage {
  private readonly http = inject(HttpClient);
  private readonly tree = inject(PageTreeStore);
  private readonly editor = viewChild(EditorComponent);
  private readonly autosaveDelay = inject(AUTOSAVE_DELAY_MS);

  readonly pageId = input.required<string>();
  protected readonly page = httpResource<PageDetail>(() => `/api/pages/${this.pageId()}`);
  protected readonly saved = httpResource<PageContent>(() => `/api/pages/${this.pageId()}/content`);
  /** Loaded content, but only once it is this page's (never a previous page's still in flight). */
  protected readonly loadedContent = computed(() => {
    const saved = this.saved.hasValue() ? this.saved.value() : undefined;
    return saved?.page_id === this.pageId() ? saved : undefined;
  });
  /** The latest document as Tiptap JSON. */
  readonly content = signal<JSONContent>(EMPTY_DOC);
  protected readonly titleError = signal(false);

  /** One autosave per page, so a pending save always goes to the page it was typed on. */
  readonly autosave = signal<Autosave<JSONContent> | null>(null);
  protected readonly saveMessage = computed(() => {
    const autosave = this.autosave();
    switch (autosave?.status()) {
      case 'pending':
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return autosave.error() instanceof HttpErrorResponse && (autosave.error() as HttpErrorResponse).status === 413
          ? 'Too large to save'
          : "Couldn't save";
      default:
        return '';
    }
  });

  constructor() {
    effect(() => {
      const pageId = this.pageId();
      untracked(() => {
        this.leave(this.autosave());
        this.content.set(EMPTY_DOC);
        this.autosave.set(
          new Autosave<JSONContent>(
            (doc) => firstValueFrom(this.http.put(`/api/pages/${pageId}/content`, { content: doc })),
            this.autosaveDelay,
          ),
        );
      });
    });
    inject(DestroyRef).onDestroy(() => this.leave(this.autosave()));
  }

  protected contentChanged(doc: JSONContent): void {
    this.content.set(doc);
    this.autosave()?.change(doc);
  }

  protected retrySave(): void {
    void this.autosave()?.flush();
  }

  /** Ask the browser to confirm leaving while edits are unsaved, and start saving them. */
  protected warnIfUnsaved(event: BeforeUnloadEvent): void {
    const autosave = this.autosave();
    if (!autosave?.hasUnsavedChanges) return;
    void autosave.flush();
    event.preventDefault();
  }

  /** Enter in the title saves it and moves the caret to the start of the content. */
  protected async titleEnter(event: Event, field: HTMLInputElement): Promise<void> {
    event.preventDefault();
    this.editor()?.focus('start');
    await this.saveTitle(field);
  }

  protected async saveTitle(field: HTMLInputElement): Promise<void> {
    const page = this.page.value();
    const title = field.value.trim();
    if (!page || title === page.title) return;
    this.titleError.set(false);
    try {
      const saved = await firstValueFrom(this.http.patch<PageDetail>(`/api/pages/${page.id}`, { title }));
      this.page.set(saved);
      this.tree.applyTitle(saved.id, saved.title);
    } catch {
      field.value = page.title;
      this.titleError.set(true);
    }
  }

  /** Save what's left for the page being left, then stop its timer. */
  private leave(autosave: Autosave<JSONContent> | null): void {
    if (!autosave) return;
    void autosave.flush().finally(() => autosave.dispose());
  }
}
