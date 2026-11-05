import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { SlashCommand } from './slash-commands';
import { SlashMenuController } from './slash-menu.controller';

export const slashMenuKey = new PluginKey('slashMenu');

export interface SlashMenuOptions {
  controller: SlashMenuController | null;
}

/** "/" at the start of a line or after a space opens the slash menu (T10). */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',
  // Run its key handling early, so Enter/Tab/arrows reach the menu while it is open (also in lists).
  priority: 1000,

  addOptions() {
    return { controller: null };
  },

  addProseMirrorPlugins() {
    const controller = this.options.controller;
    if (!controller) return [];
    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        pluginKey: slashMenuKey,
        char: '/',
        allowSpaces: false,
        // The menu filters its own list (and keeps tabs), so the plugin needs no items.
        items: () => [],
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: (props) =>
            controller.start({ query: props.query, range: props.range, clientRect: props.clientRect, command: props.command }),
          onUpdate: (props) =>
            controller.update({ query: props.query, range: props.range, clientRect: props.clientRect, command: props.command }),
          onExit: () => controller.close(),
          onKeyDown: ({ event }) => controller.keyDown(event),
        }),
      }),
    ];
  },
});

export { exitSuggestion };
