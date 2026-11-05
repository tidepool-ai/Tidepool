import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { USER, settle, tokenResponse, provideAwakeServer } from '../../../testing/auth-testing';
import { routes } from '../../app.routes';

describe('VerifyPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting(), provideAwakeServer()],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  it('signs in with the link token and opens the remembered page', async () => {
    localStorage.setItem('tidepool.returnUrl', '/p/abc');
    await harness.navigateByUrl('/auth/verify?token=link-token');

    const verify = http.expectOne('/api/auth/verify');
    expect(verify.request.body).toEqual({ token: 'link-token' });
    verify.flush(tokenResponse());
    await settle();
    http.expectOne('/api/auth/me').flush(USER);
    // Navigating loads the shell and page code lazily, which takes a few ticks.
    const router = TestBed.inject(Router);
    for (let i = 0; i < 50 && router.url !== '/p/abc'; i++) await settle();

    expect(router.url).toBe('/p/abc');
    expect(localStorage.getItem('tidepool.returnUrl')).toBeNull();
  });

  it('explains an invalid or expired link and offers a new one', async () => {
    await harness.navigateByUrl('/auth/verify?token=old');
    http.expectOne('/api/auth/verify').flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    harness.detectChanges();

    const element = harness.routeNativeElement!;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('expire');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/login');
  });

  it('treats a missing token as an invalid link', async () => {
    await harness.navigateByUrl('/auth/verify');
    harness.detectChanges();
    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toContain("doesn't work");
    http.expectNone('/api/auth/verify');
  });
});
