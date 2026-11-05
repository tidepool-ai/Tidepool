import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { ServerWake } from './core/server-wake';

describe('App', () => {
  it('renders the router outlet', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('router-outlet')).toBeTruthy();
  });

  it('shows a notice while the server is waking up', async () => {
    const waking = signal(false);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: ServerWake, useValue: { waking, isAwake: () => true } }],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="status"]')).toBeNull();

    waking.set(true);
    await fixture.whenStable();
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Waking up the server');
  });
});
