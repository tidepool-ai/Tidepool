import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../../../testing/auth-testing';
import { MEMBERS, PROPERTIES, database, row } from '../../../../testing/database-testing';
import { Row } from '../database.api';
import { RowProperties } from './row-properties';

describe('RowProperties (T19)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<RowProperties>;
  let element: HTMLElement;
  let changes: Row[];

  async function open(current: Row, options: { readOnly?: boolean; link?: boolean } = {}) {
    fixture = TestBed.createComponent(RowProperties);
    element = fixture.nativeElement;
    changes = [];
    fixture.componentInstance.rowChange.subscribe((r) => changes.push(r));
    fixture.componentRef.setInput('databaseId', 'db1');
    fixture.componentRef.setInput('rowId', current.id);
    fixture.componentRef.setInput('workspaceId', 'ws');
    fixture.componentRef.setInput('readOnly', options.readOnly ?? false);
    fixture.componentRef.setInput('showDatabaseLink', options.link ?? false);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/databases/db1').flush(database());
    http.expectOne(`/api/databases/db1/rows/${current.id}`).flush(current);
    http.expectOne('/api/workspaces/ws/members').flush(MEMBERS);
    await stable();
  }

  async function stable() {
    await settle();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const field = <T extends HTMLElement = HTMLInputElement>(id: string) => element.querySelector<T>(`#row-prop-${id}`)!;
  const saved = (body: unknown, reply: Row) => {
    const request = http.expectOne('/api/databases/db1/rows/r1');
    expect([request.request.method, request.request.body]).toEqual(['PATCH', body]);
    request.flush(reply);
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('lists every property but the title, labelled, with its value', async () => {
    await open(row('r1', 'Launch', { notes: 'Ship', points: 3, priority: 'high', tags: ['web'], due: { start: '2026-11-05', end: null }, done: true }));
    const labels = Array.from(element.querySelectorAll('dt label')).map((l) => l.textContent!.trim());
    expect(labels).toEqual(PROPERTIES.filter((p) => p.type !== 'title').map((p) => p.name));
    expect(field('notes').value).toBe('Ship');
    expect(field('points').value).toBe('3');
    expect(field<HTMLSelectElement>('priority').value).toBe('high');
    expect(field<HTMLSelectElement>('state').value).toBe('');
    expect(Array.from(field('tags').querySelectorAll<HTMLInputElement>('input')).map((b) => b.checked)).toEqual([false, true]);
    expect(field('due').value).toBe('2026-11-05');
    expect(field('done').checked).toBe(true);
    expect(field('owner').querySelectorAll('input')).toHaveLength(2); // workspace members
    // Each label points at its field.
    expect(element.querySelector('label[for="row-prop-notes"]')).toBeTruthy();
  });

  it('saves each kind of change and reports it', async () => {
    await open(row('r1', 'x'));
    field('notes').value = 'Hello';
    field('notes').dispatchEvent(new Event('blur'));
    await settle();
    saved({ properties: { notes: 'Hello' } }, row('r1', 'x', { notes: 'Hello' }));
    await stable();
    expect(changes.at(-1)!.properties).toEqual({ notes: 'Hello' });

    field('points').value = '4.5';
    field('points').dispatchEvent(new Event('blur'));
    await settle();
    saved({ properties: { points: 4.5 } }, row('r1', 'x', { notes: 'Hello', points: 4.5 }));
    await stable();

    const state = field<HTMLSelectElement>('state');
    state.value = 'done';
    state.dispatchEvent(new Event('change'));
    await settle();
    saved({ properties: { state: 'done' } }, row('r1', 'x', { state: 'done' }));
    await stable();

    field('tags').querySelectorAll<HTMLInputElement>('input')[0].click();
    await settle();
    saved({ properties: { tags: ['api'] } }, row('r1', 'x', { tags: ['api'] }));
    await stable();

    field('owner').querySelectorAll<HTMLInputElement>('input')[1].click();
    await settle();
    saved({ properties: { owner: ['u-bob'] } }, row('r1', 'x', { owner: ['u-bob'] }));
    await stable();

    field('due').value = '2026-12-01';
    field('due').dispatchEvent(new Event('change'));
    await settle();
    saved({ properties: { due: { start: '2026-12-01', end: null } } }, row('r1', 'x'));
    await stable();

    field('done').click();
    await settle();
    saved({ properties: { done: true } }, row('r1', 'x', { done: true }));
    await stable();
    expect(changes).toHaveLength(7);
  });

  it('checks numbers and links before saving', async () => {
    await open(row('r1', 'x'));
    field('points').value = 'many';
    field('points').dispatchEvent(new Event('blur'));
    field('link').value = 'example.com';
    field('link').dispatchEvent(new Event('blur'));
    await stable();
    http.expectNone('/api/databases/db1/rows/r1');
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('links start with http');
  });

  it('puts the old value back and says why when saving fails', async () => {
    await open(row('r1', 'x', { notes: 'Before' }));
    field('notes').value = 'After';
    field('notes').dispatchEvent(new Event('blur'));
    await settle();
    http.expectOne('/api/databases/db1/rows/r1').flush({ detail: 'Restore the row before changing it' }, { status: 409, statusText: 'Conflict' });
    await stable();
    expect(field('notes').value).toBe('Before');
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('Restore the row');
    expect(changes).toEqual([]);
  });

  it('links back to its database when open as a full page; read-only in the trash', async () => {
    await open(row('r1', 'x'), { link: true, readOnly: true });
    const link = element.querySelector<HTMLAnchorElement>('.breadcrumb a')!;
    expect([link.textContent!.trim(), link.getAttribute('href')]).toEqual(['Tasks', '/p/p1']);
    expect(field('notes').readOnly).toBe(true);
    expect(field<HTMLSelectElement>('state').disabled).toBe(true);
    expect(field('done').disabled).toBe(true);
  });
});
