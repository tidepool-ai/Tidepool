import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { Awareness } from 'y-protocols/awareness';

/** What each tab shares about its person (awareness `user` field). */
export interface PresenceUser {
  id: string;
  name: string;
}

export interface Viewer extends PresenceUser {
  initials: string;
  /** 0..4: which token pair colors the avatar. */
  hue: number;
}

export const MAX_AVATARS = 4;

export function initials(name: string): string {
  const base = name.split('@')[0];
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : base.slice(0, 2);
  return letters.toUpperCase() || '?';
}

export function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 5;
}

/** Everyone else with the page open, once per person (they may have several tabs). */
export function viewers(awareness: Awareness, selfId: string | null): Viewer[] {
  const seen = new Map<string, Viewer>();
  awareness.getStates().forEach((state, clientId) => {
    const user = state['user'] as PresenceUser | undefined;
    if (clientId === awareness.clientID || !user?.id || user.id === selfId || seen.has(user.id)) return;
    seen.set(user.id, { ...user, initials: initials(user.name), hue: hueOf(user.id) });
  });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Avatars of the other people on the page (FR-23), for the page's top bar. */
@Component({
  selector: 'app-presence',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './presence.scss',
  template: `
    @if (people().length) {
      <ul class="avatars" [attr.aria-label]="label()">
        @for (person of shown(); track person.id) {
          <li class="avatar" [attr.data-hue]="person.hue" [title]="person.name">
            <span aria-hidden="true">{{ person.initials }}</span>
            <span class="visually-hidden">{{ person.name }}</span>
          </li>
        }
        @if (hidden() > 0) {
          <li class="avatar more" [title]="hiddenNames()">
            <span aria-hidden="true">+{{ hidden() }}</span>
            <span class="visually-hidden">and {{ hidden() }} more: {{ hiddenNames() }}</span>
          </li>
        }
      </ul>
    }
  `,
})
export class Presence {
  readonly awareness = input<Awareness | null>(null);
  /** The signed-in person, so their other tabs don't show up as someone else. */
  readonly selfId = input<string | null>(null);

  protected readonly people = signal<Viewer[]>([]);
  protected readonly shown = computed(() => this.people().slice(0, MAX_AVATARS));
  protected readonly hidden = computed(() => Math.max(0, this.people().length - MAX_AVATARS));
  protected readonly hiddenNames = computed(() =>
    this.people()
      .slice(MAX_AVATARS)
      .map((person) => person.name)
      .join(', '),
  );
  protected readonly label = computed(() => {
    const count = this.people().length;
    return count === 1 ? 'Also here: 1 person' : `Also here: ${count} people`;
  });

  constructor() {
    effect((onCleanup) => {
      const awareness = this.awareness();
      const selfId = this.selfId();
      if (!awareness) {
        this.people.set([]);
        return;
      }
      const update = () => this.people.set(viewers(awareness, selfId));
      awareness.on('change', update);
      update();
      onCleanup(() => awareness.off('change', update));
    });
  }
}
