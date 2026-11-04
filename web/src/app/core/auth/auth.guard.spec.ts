import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { USER, rejectRefresh, settle, signIn, tokenResponse } from '../../../testing/auth-testing';
import { routes } from '../../app.routes';
import { AuthService } from './auth.service';
import { safeReturnUrl } from './auth.guard';

describe('auth guards and routes', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes, withComponentInputBinding()),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  const url = () => TestBed.inject(Router).url;

  for (const path of ['/home', '/p/abc123', '/settings/appearance']) {
    it(`redirects signed-out users from ${path} to /login with a return URL`, async () => {
      const navigation = harness.navigateByUrl(path);
      await settle();
      rejectRefresh(http);
      await navigation;

      expect(url()).toBe(`/login?returnUrl=${encodeURIComponent(path)}`);
      expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toContain('Sign in');
    });
  }

  it('lets signed-in users into the shell', async () => {
    await signIn(TestBed.inject(AuthService), http);
    await harness.navigateByUrl('/p/abc123');

    expect(url()).toBe('/p/abc123');
    expect(harness.routeNativeElement?.textContent).toContain('Page abc123');
  });

  it('restores the session from the refresh cookie instead of redirecting', async () => {
    const navigation = harness.navigateByUrl('/home');
    await settle();
    http.expectOne('/api/auth/refresh').flush(tokenResponse());
    await settle();
    http.expectOne('/api/auth/me').flush(USER);
    await navigation;

    expect(url()).toBe('/home');
  });

  it('sends signed-in users from /login to /home', async () => {
    await signIn(TestBed.inject(AuthService), http);
    await harness.navigateByUrl('/login');
    expect(url()).toBe('/home');
  });

  it('opens the root and unknown paths on /home', async () => {
    await signIn(TestBed.inject(AuthService), http);
    await harness.navigateByUrl('/');
    expect(url()).toBe('/home');
    await harness.navigateByUrl('/nope');
    expect(url()).toBe('/home');
  });

  it('lazy-loads every feature route', () => {
    const lazy = (list: typeof routes): boolean[] =>
      list.flatMap((route) => [
        ...(route.redirectTo ? [] : [typeof route.loadComponent === 'function' && !route.component]),
        ...lazy(route.children ?? []),
      ]);
    expect(lazy(routes).every(Boolean)).toBe(true);
  });
});

describe('safeReturnUrl', () => {
  it('only allows in-app paths', () => {
    expect(safeReturnUrl('/p/1?x=2')).toBe('/p/1?x=2');
    expect(safeReturnUrl('//evil.example')).toBe('/home');
    expect(safeReturnUrl('https://evil.example')).toBe('/home');
    expect(safeReturnUrl(null)).toBe('/home');
  });
});
