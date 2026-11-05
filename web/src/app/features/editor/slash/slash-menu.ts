import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, inject, input } from '@angular/core';
import { SLASH_TABS } from './slash-commands';
import { SlashMenuController } from './slash-menu.controller';

/**
 * The slash menu popup. Focus stays in the editor: the editor points at the active option with
 * aria-activedescendant, and mouse presses here don't take focus away from it.
 */
@Component({
  selector: 'app-slash-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './slash-menu.html',
  styleUrl: './slash-menu.scss',
})
export class SlashMenuView {
  readonly controller = input.required<SlashMenuController>();
  protected readonly tabs = SLASH_TABS;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Keep the highlighted option in view as the keyboard moves through a list taller than the menu.
    afterRenderEffect(() => {
      const menu = this.controller();
      if (!menu.open()) return;
      const option = this.host.nativeElement.querySelector<HTMLElement>(`#${menu.optionId(menu.activeIndex())}`);
      option?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  /** Keep the caret in the editor while clicking in the menu. */
  protected keepEditorFocus(event: MouseEvent): void {
    event.preventDefault();
  }
}
