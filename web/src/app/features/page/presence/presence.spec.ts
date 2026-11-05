import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { hueOf, initials, viewers } from './presence';

describe('presence helpers', () => {
  it('makes initials from names and email addresses', () => {
    expect(initials('grace.hopper@example.com')).toBe('GH');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('bob@example.com')).toBe('BO');
    expect(initials('')).toBe('?');
  });

  it('gives each person a stable color out of five', () => {
    expect(hueOf('u-1')).toBe(hueOf('u-1'));
    const hues = new Set(Array.from({ length: 50 }, (_, i) => hueOf(`user-${i}`)));
    expect([...hues].every((hue) => hue >= 0 && hue < 5)).toBe(true);
    expect(hues.size).toBeGreaterThan(1);
  });

  it('lists other people once each, by name, leaving out this tab and its person', () => {
    const mine = new Awareness(new Y.Doc());
    mine.setLocalStateField('user', { id: 'me', name: 'me@example.com' });
    const states = mine.getStates();
    states.set(101, { user: { id: 'u-zoe', name: 'zoe@example.com' } });
    states.set(102, { user: { id: 'u-amy', name: 'amy@example.com' } });
    states.set(103, { user: { id: 'u-amy', name: 'amy@example.com' } }); // second tab
    states.set(104, { user: { id: 'me', name: 'me@example.com' } }); // my other tab
    states.set(105, {}); // no user yet
    expect(viewers(mine, 'me').map((v) => v.name)).toEqual(['amy@example.com', 'zoe@example.com']);
  });
});
