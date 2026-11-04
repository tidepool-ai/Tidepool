import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { PageTreeStore, pageTitle } from './page-tree.store';

/** One row of the sidebar tree plus, when expanded, its children (rendered recursively). */
@Component({
  selector: 'app-page-tree-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './page-tree-item.html',
  styleUrl: './page-tree-item.scss',
})
export class PageTreeItem {
  protected readonly store = inject(PageTreeStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly pageId = input.required<string>();
  readonly level = input(0);

  private readonly link = viewChild<ElementRef<HTMLAnchorElement>>('link');
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  protected readonly page = computed(() => this.store.pages()[this.pageId()]);
  protected readonly name = computed(() => pageTitle(this.page()));
  protected readonly expanded = computed(() => !!this.store.expanded()[this.pageId()]);
  protected readonly childIds = computed(() => this.store.children()[this.pageId()]);
  protected readonly renaming = computed(() => this.store.renamingId() === this.pageId());
  protected readonly indent = computed(() => 4 + this.level() * 14);

  constructor() {
    // Focus and select the title field whenever this row enters rename mode.
    effect(() => {
      const field = this.titleInput()?.nativeElement;
      if (field) {
        field.focus();
        field.select();
      }
    });
  }

  protected startRename(event?: Event): void {
    event?.preventDefault();
    this.store.startRename(this.pageId());
  }

  protected async save(field: HTMLInputElement): Promise<void> {
    if (!this.renaming()) return; // Enter already saved; this is the blur that follows.
    await this.store.rename(this.pageId(), field.value.trim());
    this.focusLink();
  }

  protected cancel(): void {
    this.store.stopRename();
    this.focusLink();
  }

  protected addChild(): Promise<unknown> {
    return this.store.create(this.pageId());
  }

  protected async trash(): Promise<void> {
    const id = this.pageId();
    const current = this.router.url.match(/^\/p\/([^/?#]+)/)?.[1];
    // Keep focus nearby once this row disappears: the parent page's link, or "Add a page".
    const host = this.host.nativeElement;
    const fallback =
      host.parentElement?.closest('app-page-tree-item')?.querySelector<HTMLElement>('a.title') ??
      host.closest('.page-tree')?.querySelector<HTMLElement>('.add-page');
    if (!(await this.store.trash(id))) return;
    if (current && this.store.isWithin(current, id)) await this.router.navigateByUrl('/home');
    fallback?.focus();
  }

  private focusLink(): void {
    afterNextRender(() => this.link()?.nativeElement.focus(), { injector: this.injector });
  }
}
