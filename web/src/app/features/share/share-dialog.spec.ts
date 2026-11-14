import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { settle } from '../../../testing/auth-testing';
import { Permissions, Person, ShareDialog } from './share-dialog';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function person(email: string, level: Person['level'], extra: Partial<Person> = {}): Person {
  return { user_id: `u-${email.split('@')[0]}`, email, level, inherited_from: null, role: 'member', ...extra };
}

function permissions(extra: Partial<Permissions> = {}): Permissions {
  return {
    page_id: 'p1',
    access: 'full',
    can_share: true,
    general: { access: 'workspace', level: 'full', inherited_from: null },
    people: [],
    ...extra,
  };
}

const MEMBERS = [
  { user_id: 'u-ada', email: 'ada@example.com', role: 'owner' },
  { user_id: 'u-bob', email: 'bob@example.com', role: 'member' },
  { user_id: 'u-gus', email: 'gus@example.com', role: 'guest' },
];

describe('ShareDialog (T21)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<ShareDialog>;
  let element: HTMLElement;
  let closed: number;

  async function stable() {
    await settle();
    await fixture.whenStable();
    await frame();
    fixture.detectChanges();
  }

  async function open(shared: Permissions = permissions(), hasParent = true) {
    fixture = TestBed.createComponent(ShareDialog);
    element = fixture.nativeElement;
    document.body.appendChild(element); // so focus can move into it
    closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.componentRef.setInput('title', 'Roadmap');
    fixture.componentRef.setInput('hasParent', hasParent);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/pages/p1/permissions').flush(shared);
    await settle();
    if (shared.can_share) http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
  }

  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await stable();
  };
  const people = () =>
    Array.from(element.querySelectorAll('.people li')).map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
  const status = () => element.querySelector('[role="status"]')!.textContent!.trim();

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    fixture?.destroy();
  });

  it('is a labelled modal dialog that takes focus', async () => {
    await open();
    const dialog = element.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(element.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)!.textContent).toBe('Share “Roadmap”');
    expect(document.activeElement).toBe(element.querySelector('#share-email'));
  });

  it('invites by email with a level and shows them in the list', async () => {
    await open();
    // Members who aren't listed yet are suggested (not guests).
    expect(Array.from(element.querySelectorAll('#share-members option')).map((o) => o.getAttribute('value'))).toEqual([
      'ada@example.com',
      'bob@example.com',
    ]);
    const input = element.querySelector<HTMLInputElement>('#share-email')!;
    input.value = 'cy@example.com';
    input.dispatchEvent(new Event('input'));
    await choose(element.querySelector<HTMLSelectElement>('#share-level')!, 'view');
    element.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    const request = http.expectOne('/api/pages/p1/share');
    expect(request.request.body).toEqual({ email: 'cy@example.com', level: 'view' });
    request.flush(permissions({ people: [person('cy@example.com', 'view', { role: 'guest' })] }));
    await stable();
    expect(people()).toHaveLength(1);
    expect(people()[0]).toContain('cy@example.com');
    expect(people()[0]).toContain('Guest');
    expect(element.querySelector<HTMLSelectElement>('[aria-label="Access for cy@example.com"]')!.value).toBe('view');
    expect(input.value).toBe('');
    expect(status()).toBe('Invited cy@example.com: Can view');
  });

  it('shows why an invite was refused', async () => {
    await open();
    const input = element.querySelector<HTMLInputElement>('#share-email')!;
    input.value = 'not-an-email';
    input.dispatchEvent(new Event('input'));
    element.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    http.expectOne('/api/pages/p1/share').flush({ detail: [] }, { status: 422, statusText: 'Unprocessable' });
    await stable();
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('Enter a valid email address.');
  });

  it("changes and removes people's access, and says where inherited access comes from", async () => {
    const parent = { id: 'p0', title: 'Team' };
    await open(
      permissions({
        people: [person('bob@example.com', 'edit'), person('cy@example.com', 'view', { inherited_from: parent })],
      }),
    );
    expect(people()[1]).toContain('From “Team”');
    // Inherited access can be overridden here, but not removed here.
    const cy = element.querySelector<HTMLSelectElement>('[aria-label="Access for cy@example.com"]')!;
    expect(Array.from(cy.options).map((o) => o.value)).not.toContain('remove');

    await choose(cy, 'comment');
    const put = http.expectOne('/api/pages/p1/permissions/u-cy');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ level: 'comment' });
    put.flush(permissions({ people: [person('bob@example.com', 'edit'), person('cy@example.com', 'comment')] }));
    await stable();

    await choose(element.querySelector<HTMLSelectElement>('[aria-label="Access for bob@example.com"]')!, 'remove');
    const remove = http.expectOne('/api/pages/p1/permissions/u-bob');
    expect(remove.request.method).toBe('DELETE');
    remove.flush(permissions({ people: [person('cy@example.com', 'comment')] }));
    await stable();
    expect(people()).toHaveLength(1);
    expect(status()).toBe('Removed bob@example.com');
  });

  it("refuses to take away the person's own full access, with the server's reason", async () => {
    await open(permissions({ people: [person('ada@example.com', 'full')] }));
    await choose(element.querySelector<HTMLSelectElement>('[aria-label="Access for ada@example.com"]')!, 'edit');
    http
      .expectOne('/api/pages/p1/permissions/u-ada')
      .flush({ detail: "You can't take away your own full access" }, { status: 409, statusText: 'Conflict' });
    await stable();
    expect(element.querySelector('[role="alert"]')!.textContent).toContain("You can't take away your own full access");
  });

  it('sets general access and the level workspace members get', async () => {
    await open(permissions({ general: { access: 'workspace', level: 'full', inherited_from: { id: 'p0', title: 'Team' } } }));
    const general = element.querySelector<HTMLSelectElement>('[aria-labelledby="general-label"]')!;
    expect(general.value).toBe('inherit');
    expect(element.querySelector('#general-note')!.textContent).toContain('Set on “Team”');

    await choose(general, 'invited');
    const narrow = http.expectOne('/api/pages/p1/general-access');
    expect(narrow.request.body).toEqual({ access: 'invited', level: 'full' });
    narrow.flush(permissions({ general: { access: 'invited', level: 'full', inherited_from: null } }));
    await stable();
    expect(element.querySelector('[aria-label="Access for workspace members"]')).toBeNull();
    expect(status()).toBe('Only people invited can open this page');

    await choose(element.querySelector<HTMLSelectElement>('[aria-labelledby="general-label"]')!, 'public');
    http
      .expectOne('/api/pages/p1/general-access')
      .flush(permissions({ general: { access: 'public', level: 'full', inherited_from: null } }));
    await stable();
    await choose(element.querySelector<HTMLSelectElement>('[aria-label="Access for workspace members"]')!, 'view');
    const level = http.expectOne('/api/pages/p1/general-access');
    expect(level.request.body).toEqual({ access: 'public', level: 'view' });
    level.flush(permissions({ general: { access: 'public', level: 'view', inherited_from: null } }));
    await stable();
    expect(element.querySelector('#general-note')!.textContent).toContain('Anyone else with the link who signs in can view');

    await choose(element.querySelector<HTMLSelectElement>('[aria-labelledby="general-label"]')!, 'inherit');
    expect(http.expectOne('/api/pages/p1/general-access').request.body).toEqual({ access: null, level: 'view' });
  });

  it('offers no "same as the page above" for a top-level page', async () => {
    await open(permissions(), false);
    const options = Array.from(element.querySelectorAll<HTMLOptionElement>('[aria-labelledby="general-label"] option'));
    expect(options.map((o) => o.value)).toEqual(['invited', 'workspace', 'public']);
  });

  it('shows the list but no controls without full access', async () => {
    await open(permissions({ access: 'edit', can_share: false, people: [person('bob@example.com', 'full')] }));
    expect(element.querySelector('form')).toBeNull();
    expect(element.querySelector('.people select')).toBeNull();
    expect(element.querySelector('.note')!.textContent).toContain('You have can edit here');
    expect(people()[0]).toContain('Full access');
  });

  it('copies the link and closes with Escape, Done or the backdrop', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open();
    Array.from(element.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Copy link')!.click();
    await stable();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/p/p1`);
    expect(status()).toBe('Link copied');

    element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    element.querySelector<HTMLElement>('.backdrop')!.click();
    Array.from(element.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Done')!.click();
    expect(closed).toBe(3);
  });

  it('can try again when loading fails', async () => {
    fixture = TestBed.createComponent(ShareDialog);
    element = fixture.nativeElement;
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/pages/p1/permissions').flush(null, { status: 500, statusText: 'Error' });
    await stable();
    expect(element.querySelector('[role="alert"]')!.textContent).toContain("Couldn't load who has access");
    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle();
    http.expectOne('/api/pages/p1/permissions').flush(permissions({ can_share: false }));
    await stable();
    expect(element.querySelector('h3')!.textContent).toBe('People with access');
  });
});
