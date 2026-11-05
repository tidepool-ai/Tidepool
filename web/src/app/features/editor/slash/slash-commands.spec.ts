import { SLASH_COMMANDS, SLASH_TABS, filterCommands } from './slash-commands';

const titles = (query: string, tab: Parameters<typeof filterCommands>[1] = 'all') =>
  filterCommands(query, tab).map((command) => command.title);

describe('slash commands', () => {
  it('has the All, Blocks, AI and Embeds tabs, in that order', () => {
    expect(SLASH_TABS.map((tab) => tab.label)).toEqual(['All', 'Blocks', 'AI', 'Embeds']);
  });

  it('lists every block when nothing is typed', () => {
    expect(titles('')).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'To-do list',
      'Toggle',
      'Quote',
      'Callout',
      'Divider',
      'Code',
      'Image',
    ]);
    expect(titles('', 'blocks')).toEqual(titles('').filter((title) => title !== 'Image'));
  });

  it('has Image under Embeds, and nothing in AI yet', () => {
    expect(titles('', 'embeds')).toEqual(['Image']);
    expect(titles('', 'ai')).toEqual([]);
  });

  it('finds Image by picture words', () => {
    for (const query of ['image', 'photo', 'picture', 'upload']) expect(titles(query), query).toContain('Image');
  });

  describe('filtering', () => {
    it('matches the start of the title, ignoring case and spaces around the query', () => {
      expect(titles('head')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
      expect(titles('  HEADING 2 ')).toEqual(['Heading 2']);
    });

    it('matches any word in the title', () => {
      expect(titles('list')).toEqual(['Bulleted list', 'Numbered list', 'To-do list']);
    });

    it('matches keywords people type', () => {
      expect(titles('h2')).toEqual(['Heading 2']);
      expect(titles('ul')).toEqual(['Bulleted list']);
      expect(titles('ol')).toEqual(['Numbered list']);
      expect(titles('#')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
      expect(titles('paragraph')).toEqual(['Text']);
      expect(titles('todo')).toEqual(['To-do list']);
      expect(titles('hr')).toEqual(['Divider']);
      expect(titles('```')).toEqual(['Code']);
      expect(titles('note')).toEqual(['Callout']);
      expect(titles('details')).toEqual(['Toggle']);
      expect(titles('>')).toEqual(['Quote']);
    });

    it('ranks title prefixes before word and keyword matches', () => {
      // "t": "Text" starts with t; "title" is a keyword of Heading 1.
      expect(titles('t')[0]).toBe('Text');
      expect(titles('t')).toContain('Heading 1');
    });

    it('returns nothing for an unknown query', () => {
      expect(titles('zzz')).toEqual([]);
    });

    it('filters within the selected tab', () => {
      expect(titles('head', 'ai')).toEqual([]);
      expect(titles('head', 'blocks')).toHaveLength(3);
    });
  });

  it('gives every command a unique id', () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
