import { A11yModule } from '@angular/cdk/a11y';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type Level = 'view' | 'comment' | 'edit' | 'full';
export type GeneralAccess = 'invited' | 'workspace' | 'public';

interface PageRef {
  id: string;
  title: string;
}

export interface Person {
  user_id: string;
  email: string;
  level: Level;
  inherited_from: PageRef | null;
  role: string | null;
}

export interface Permissions {
  page_id: string;
  access: Level;
  can_share: boolean;
  general: { access: GeneralAccess; level: Level; inherited_from: PageRef | null };
  people: Person[];
}

interface Member {
  user_id: string;
  email: string;
  role: string;
}

export const LEVELS: readonly { value: Level; label: string }[] = [
  { value: 'full', label: 'Full access' },
  { value: 'edit', label: 'Can edit' },
  { value: 'comment', label: 'Can comment' },
  { value: 'view', label: 'Can view' },
];

export function levelLabel(level: Level): string {
  return LEVELS.find((l) => l.value === level)?.label ?? level;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    if (typeof error.error?.detail === 'string') return error.error.detail;
    if (error.status === 422) return 'Enter a valid email address.';
  }
  return fallback;
}

/** FR-31: invite people by email, change or remove their access, set general access, copy the link (T21). */
@Component({
  selector: 'app-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule],
  templateUrl: './share-dialog.html',
  styleUrl: './share-dialog.scss',
  host: { '(document:keydown.escape)': 'escape($event)', '(click)': 'backdropClick($event)' },
})
export class ShareDialog {
  private readonly http = inject(HttpClient);

  readonly pageId = input.required<string>();
  readonly workspaceId = input.required<string>();
  readonly title = input('');
  /** Top-level pages can't inherit general access, so "Same as the page above" isn't offered. */
  readonly hasParent = input(false);
  readonly closed = output<void>();

  protected readonly LEVELS = LEVELS;
  protected readonly levelLabel = levelLabel;

  protected readonly permissions = signal<Permissions | null>(null);
  protected readonly members = signal<Member[]>([]);
  protected readonly loadError = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly announcement = signal('');
  protected readonly email = signal('');
  protected readonly inviteLevel = signal<Level>('edit');

  protected readonly canShare = computed(() => !!this.permissions()?.can_share);
  /** Workspace members not yet on the list, offered as suggestions while typing. */
  protected readonly suggestions = computed(() => {
    const listed = new Set(this.permissions()?.people.map((p) => p.user_id) ?? []);
    return this.members().filter((m) => !listed.has(m.user_id) && m.role !== 'guest');
  });
  protected readonly generalChoice = computed(() => {
    const general = this.permissions()?.general;
    if (!general) return 'workspace';
    return general.inherited_from && this.hasParent() ? 'inherit' : general.access;
  });
  protected readonly link = computed(() => `${location.origin}/p/${this.pageId()}`);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    // Focus starts in the dialog: on the email field once loaded (or the Close button meanwhile).
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('.icon-button')?.focus());
    effect(() => {
      const pageId = this.pageId();
      const workspaceId = this.workspaceId();
      untracked(() => void this.load(pageId, workspaceId));
    });
  }

  protected async load(pageId = this.pageId(), workspaceId = this.workspaceId()): Promise<void> {
    this.loadError.set(false);
    try {
      this.permissions.set(await firstValueFrom(this.http.get<Permissions>(`/api/pages/${pageId}/permissions`)));
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('#share-email')?.focus(), {
        injector: this.injector,
      });
    } catch {
      this.loadError.set(true);
      return;
    }
    if (this.canShare()) {
      // Suggestions only: guests can't list members, and the dialog works without them.
      this.http.get<Member[]>(`/api/workspaces/${workspaceId}/members`).subscribe({
        next: (members) => this.members.set(members),
        error: () => this.members.set([]),
      });
    }
  }

  private async run(request: Promise<Permissions>, done: string, fallback: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.permissions.set(await request);
      this.announcement.set(done);
      return true;
    } catch (error) {
      this.error.set(reason(error, fallback));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected async invite(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.email().trim();
    if (!email || this.busy()) return;
    const level = this.inviteLevel();
    const sent = await this.run(
      firstValueFrom(this.http.post<Permissions>(`/api/pages/${this.pageId()}/share`, { email, level })),
      `Invited ${email}: ${levelLabel(level)}`,
      "Couldn't invite them",
    );
    if (sent) {
      this.email.set('');
      // Ready for the next person (the Invite button is disabled again while the field is empty).
      this.host.nativeElement.querySelector<HTMLElement>('#share-email')?.focus();
    }
  }

  protected async setLevel(person: Person, value: string): Promise<void> {
    if (value === 'remove') {
      await this.run(
        firstValueFrom(this.http.delete<Permissions>(`/api/pages/${this.pageId()}/permissions/${person.user_id}`)),
        `Removed ${person.email}`,
        "Couldn't remove them",
      );
      return;
    }
    await this.run(
      firstValueFrom(
        this.http.put<Permissions>(`/api/pages/${this.pageId()}/permissions/${person.user_id}`, { level: value }),
      ),
      `${person.email}: ${levelLabel(value as Level)}`,
      "Couldn't change their access",
    );
  }

  protected async setGeneral(access: string, level?: string): Promise<void> {
    const general = this.permissions()?.general;
    const body = {
      access: access === 'inherit' ? null : access,
      level: (level ?? general?.level ?? 'full') as Level,
    };
    const labels: Record<string, string> = {
      inherit: 'Same as the page above',
      invited: 'Only people invited can open this page',
      workspace: 'Everyone in the workspace can open this page',
      public: 'Anyone with the link can view this page',
    };
    await this.run(
      firstValueFrom(this.http.put<Permissions>(`/api/pages/${this.pageId()}/general-access`, body)),
      labels[access] ?? 'General access changed',
      "Couldn't change general access",
    );
  }

  protected async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.announcement.set('Link copied');
    } catch {
      this.error.set("Couldn't copy the link. Copy it from the address bar instead.");
    }
  }

  protected initial(email: string): string {
    return email.charAt(0).toUpperCase();
  }

  /** A click outside the dialog closes it (keyboard users have Escape and the Close button). */
  protected backdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('backdrop')) this.closed.emit();
  }

  protected escape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  }
}
