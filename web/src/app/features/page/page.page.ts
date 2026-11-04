import { HttpClient, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { JSONContent } from '@tiptap/core';
import { firstValueFrom } from 'rxjs';
import { EMPTY_DOC, EditorComponent } from '../editor/editor';
import { ApiPage, PageTreeStore } from '../page-tree/page-tree.store';

interface PageDetail extends ApiPage {
  archived_at: string | null;
}

/** /p/:pageId: the page title and its content in the block editor. */
@Component({
  selector: 'app-page-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditorComponent],
  styleUrl: './page.page.scss',
  templateUrl: './page.page.html',
})
export class PagePage {
  private readonly http = inject(HttpClient);
  private readonly tree = inject(PageTreeStore);
  private readonly editor = viewChild(EditorComponent);

  readonly pageId = input.required<string>();
  protected readonly page = httpResource<PageDetail>(() => `/api/pages/${this.pageId()}`);
  /** The document as Tiptap JSON. Loading and saving it is T09; until then it lives for the visit. */
  readonly content = signal<JSONContent>(EMPTY_DOC);
  protected readonly titleError = signal(false);

  constructor() {
    // A different page starts from an empty document (the editor is recreated per page in the template).
    effect(() => {
      this.pageId();
      untracked(() => this.content.set(EMPTY_DOC));
    });
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
}
