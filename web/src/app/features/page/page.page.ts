import { HttpClient, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { JSONContent } from '@tiptap/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import * as Y from 'yjs';
import { firstValueFrom, of } from 'rxjs';
import { EditorComponent, editorExtensions } from '../editor/editor';
import { docToJson, isBlank, seedFromJson } from '../editor/collab/seed';
import { ApiPage, PageTreeStore } from '../page-tree/page-tree.store';
import { ImageUploadService, ImageUploader } from '../../core/files/image-upload';
import { AuthService } from '../../core/auth/auth.service';
import { COLLAB_CONNECTOR, CollabConnection } from '../../core/collab/collab-connection';
import { Presence } from './presence/presence';
import { DatabaseView } from '../database/database-view';

interface PageDetail extends ApiPage {
  archived_at: string | null;
  /** A database's page shows its table instead of the editor (T17). */
  is_database?: boolean;
}

/** Content saved as JSON before live editing (T09); copied into the live document once. */
interface PageContent {
  page_id: string;
  content: JSONContent | null;
  updated_at: string | null;
}

/** What the editor shows: the live document, or (read-only pages) a snapshot of it. */
type View = { kind: 'live'; doc: Y.Doc } | { kind: 'snapshot'; content: JSONContent | null };

const CLOSED_MESSAGES: Record<string, string> = {
  'No access to this page': "You don't have access to this page any more.",
  'This page is read-only': 'This page is read-only now.',
  'Message too big': 'That change was too big to save.',
};

/** /p/:pageId: the page title and its content, edited live with everyone who has it open (T15). */
@Component({
  selector: 'app-page-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditorComponent, Presence, DatabaseView],
  styleUrl: './page.page.scss',
  templateUrl: './page.page.html',
  host: { '(window:beforeunload)': 'warnIfUnsaved($event)', '[class.wide]': 'isDatabase()' },
})
export class PagePage {
  private readonly http = inject(HttpClient);
  private readonly tree = inject(PageTreeStore);
  private readonly editor = viewChild(EditorComponent);
  private readonly images = inject(ImageUploadService);
  private readonly connect = inject(COLLAB_CONNECTOR);
  protected readonly auth = inject(AuthService);

  readonly pageId = input.required<string>();
  /** #block-<id> in the URL (block menu > Copy link) points at a block to show. */
  private readonly fragment = toSignal(inject(ActivatedRoute, { optional: true })?.fragment ?? of(null));
  protected readonly focusBlock = computed(() => {
    const fragment = this.fragment();
    return fragment?.startsWith('block-') ? fragment.slice('block-'.length) : null;
  });
  protected readonly page = httpResource<PageDetail>(() => `/api/pages/${this.pageId()}`);
  protected readonly saved = httpResource<PageContent>(() => `/api/pages/${this.pageId()}/content`);
  /** Loaded content, but only once it is this page's (never a previous page's still in flight). */
  protected readonly loadedContent = computed(() => {
    const saved = this.saved.hasValue() ? this.saved.value() : undefined;
    return saved?.page_id === this.pageId() ? saved : undefined;
  });
  protected readonly titleError = signal(false);
  /** Pasted, dropped or picked images go to this page's storage (T13). */
  protected readonly uploadImage: ImageUploader = (file, onProgress) =>
    this.images.upload(this.pageId(), file, onProgress);

  /** The page to edit live: this page once loaded, unless it's a database (whose rows are the content). */
  private readonly livePage = computed(() => {
    const page = this.page.hasValue() ? this.page.value() : undefined;
    return page?.id === this.pageId() && !page.is_database ? page.id : null;
  });
  protected readonly isDatabase = computed(() => {
    const page = this.page.hasValue() ? this.page.value() : undefined;
    return page?.id === this.pageId() && !!page.is_database;
  });

  /** This page's live document connection (one per page). */
  readonly connection = signal<CollabConnection | null>(null);
  protected readonly view = signal<View | null>(null);
  protected readonly readOnly = computed(() => !!this.page.value()?.archived_at);
  /** Editable unless the page is in the trash or the server stopped taking edits. */
  protected readonly editable = computed(() => !this.readOnly() && this.connection()?.status() !== 'closed');

  protected readonly statusMessage = computed(() => {
    const connection = this.connection();
    const view = this.view();
    if (!connection || view?.kind === 'snapshot') return '';
    switch (connection.status()) {
      case 'connecting':
        return connection.synced() ? 'Reconnecting…' : 'Connecting…';
      case 'connected':
        return 'Saved';
      case 'offline':
        return connection.unsynced() ? 'Offline. Your edits will sync when you reconnect.' : 'Offline';
      case 'closed':
        return CLOSED_MESSAGES[connection.closedReason() ?? ''] ?? 'Disconnected.';
    }
  });

  constructor() {
    // One connection per page.
    effect((onCleanup) => {
      const pageId = this.livePage();
      if (!pageId) {
        untracked(() => {
          this.view.set(null);
          this.connection.set(null);
        });
        return;
      }
      // Only the page id is a dependency: connecting reads and writes other signals.
      const connection = untracked(() => {
        const opened = this.connect(pageId);
        const user = this.auth.user();
        opened.awareness.setLocalStateField('user', {
          id: user?.id ?? `anonymous-${opened.doc.clientID}`,
          name: user?.email ?? 'Someone',
        });
        this.view.set(null);
        this.connection.set(opened);
        return opened;
      });
      onCleanup(() => connection.destroy());
    });

    // Once synced (and the page and its old JSON are loaded), decide what the editor shows.
    effect(() => {
      const connection = this.connection();
      const page = this.page.hasValue() ? this.page.value() : undefined;
      const legacy = this.loadedContent();
      if (!connection?.synced() || page?.id !== this.pageId() || !legacy || untracked(this.view)) return;
      untracked(() => {
        if (page.archived_at) {
          // Read-only: show a snapshot and stop, so nothing is ever sent for this page.
          const content = isBlank(connection.doc) ? legacy.content : docToJson(connection.doc);
          this.view.set({ kind: 'snapshot', content });
          connection.destroy();
          return;
        }
        if (legacy.content) seedFromJson(connection.doc, legacy.content, editorExtensions(''));
        this.view.set({ kind: 'live', doc: connection.doc });
      });
    });
  }

  /** Ask the browser to confirm leaving while edits made offline haven't reached the server. */
  protected warnIfUnsaved(event: BeforeUnloadEvent): void {
    if (this.connection()?.unsynced()) event.preventDefault();
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
