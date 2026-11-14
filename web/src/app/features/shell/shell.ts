import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { CommandBar } from '../command-bar/command-bar';
import { PageTree } from '../page-tree/page-tree';
import { PageTreeStore } from '../page-tree/page-tree.store';

/** Signed-in layout: icon rail, spaces panel and the main outlet (DESIGN-SYSTEM.md section 7). */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PageTree, CommandBar],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
  host: { '(document:keydown)': 'shortcutKeydown($event)' },
})
export class Shell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly pageTree = inject(PageTreeStore);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');

  protected readonly user = this.auth.user;
  private readonly injector = inject(Injector);

  /** The command bar (T22): Ctrl+K, or Cmd+K on a Mac. */
  protected readonly commandsOpen = signal(false);
  protected readonly shortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘K' : 'Ctrl K';
  /** Where focus was when the bar opened, to go back to. */
  private commandsOpener: HTMLElement | null = null;
  /** The page shown in the main area, if any (tasks from the bar go into it when it's a database). */
  protected readonly currentPageId = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.pageIdFromUrl()),
    ),
    { initialValue: this.pageIdFromUrl() },
  );

  constructor() {
    // The guard only lets signed-in users in, so losing the user means the session ended
    // (sign out here or in another tab, or a refresh that failed).
    effect(() => {
      if (this.auth.isSignedIn()) return;
      this.pageTree.reset();
      void this.router.navigate(['/login']);
    });
  }

  /** Skip link: move focus without changing the URL (a "#main" href would resolve against <base>). */
  protected skipToMain(event: Event): void {
    event.preventDefault();
    this.main().nativeElement.focus();
  }

  protected shortcutKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (this.commandsOpen()) this.closeCommands();
    else this.openCommands();
  }

  protected openCommands(): void {
    this.commandsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.commandsOpen.set(true);
  }

  protected closeCommands(): void {
    this.commandsOpen.set(false);
    const opener = this.commandsOpener;
    this.commandsOpener = null;
    // After choosing a page, focus goes to the new page (the router moves it); otherwise back where it was.
    afterNextRender(
      () => {
        if (document.activeElement && document.activeElement !== document.body) return;
        (opener?.isConnected ? opener : this.main().nativeElement).focus();
      },
      { injector: this.injector },
    );
  }

  private pageIdFromUrl(): string | null {
    return /^\/p\/([^/?#]+)/.exec(this.router.url)?.[1] ?? null;
  }

  protected signOut(): Promise<void> {
    return this.auth.logout();
  }
}
