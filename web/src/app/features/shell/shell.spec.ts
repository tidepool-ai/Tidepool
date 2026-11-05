import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { USER, settle, signIn, provideAwakeServer } from '../../../testing/auth-testing';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth/auth.service';

describe('Shell', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let page: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting(), provideAwakeServer()],
    });
    http = TestBed.inject(HttpTestingController);
    await signIn(TestBed.inject(AuthService), http);
    harness = await RouterTestingHarness.create('/home');
    page = harness.fixture.nativeElement as HTMLElement;
  });

  const focusable = () =>
    Array.from(page.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])'));

  it('starts with a skip link that moves focus to main content without navigating', async () => {
    const skip = focusable()[0];
    expect(skip.textContent).toContain('Skip to main content');

    const main = page.querySelector<HTMLElement>('main#main')!;
    expect(main.tabIndex).toBe(-1);
    skip.click();
    expect(document.activeElement).toBe(main);
    expect(TestBed.inject(Router).url).toBe('/home');
  });

  it('has the icon rail, spaces panel and main landmark', () => {
    expect(page.querySelector('nav[aria-label="Primary"]')).toBeTruthy();
    expect(page.querySelector('nav[aria-label="Spaces"]')?.textContent).toContain(USER.email);
    expect(page.querySelectorAll('main')).toHaveLength(1);
    expect(page.querySelector('main h1')?.textContent).toContain('Home');
  });

  it('uses only native, named controls so everything is reachable by keyboard', () => {
    for (const element of focusable()) {
      expect(['A', 'BUTTON', 'INPUT']).toContain(element.tagName);
      const name = element.getAttribute('aria-label') ?? element.textContent?.trim();
      expect(name, element.outerHTML).toBeTruthy();
    }
    expect(page.querySelector('[aria-label="Home"]')?.tagName).toBe('A');
    expect(page.querySelector('[aria-label="Settings"]')?.tagName).toBe('A');
    expect(page.querySelector('[aria-label="Sign out"]')?.tagName).toBe('BUTTON');
  });

  it('marks the current section with aria-current', async () => {
    expect(page.querySelector('[aria-label="Home"]')?.getAttribute('aria-current')).toBe('page');
    await harness.navigateByUrl('/settings/appearance');
    expect(page.querySelector('[aria-label="Settings"]')?.getAttribute('aria-current')).toBe('page');
    expect(page.querySelector('[aria-label="Home"]')?.hasAttribute('aria-current')).toBe(false);
  });

  it('signs out and returns to the login page', async () => {
    page.querySelector<HTMLButtonElement>('[aria-label="Sign out"]')!.click();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await harness.fixture.whenStable();

    expect(TestBed.inject(AuthService).isSignedIn()).toBe(false);
    expect(TestBed.inject(Router).url).toBe('/login');
  });
});
