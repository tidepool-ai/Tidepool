import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { USER, settle, tokenResponse } from '../../../testing/auth-testing';
import { ServerUnavailableError, WAKE_OPTIONS } from '../server-wake';
import { AuthService } from './auth.service';

/** AuthService with the real ServerWake (short timings): requests that mustn't repeat wait for the server. */
describe('AuthService with a sleeping server', () => {
  let http: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WAKE_OPTIONS, useValue: { intervalMs: 5, giveUpAfterMs: 30, attemptTimeoutMs: 1000, freshForMs: 60_000, showAfterMs: 1000 } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => http.verify());

  it('waits for the server before refreshing, so the refresh token is only sent once', async () => {
    const done = auth.ensureSession();
    http.expectNone('/api/auth/refresh');
    http.expectOne('/api/health').flush(null, { status: 504, statusText: 'Gateway Timeout' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    http.expectNone('/api/auth/refresh');
    http.expectOne('/api/health').flush({});
    await settle();
    http.expectOne('/api/auth/refresh').flush(tokenResponse());
    await settle();
    http.expectOne('/api/auth/me').flush(USER);
    expect(await done).toBe(true);
  });

  it('reports no session, without refreshing, when the server never wakes', async () => {
    const done = auth.ensureSession();
    for (let i = 0; i < 20; i++) {
      http.match('/api/health').forEach((r) => r.flush(null, { status: 503, statusText: 'Starting' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await done).toBe(false);
    http.expectNone('/api/auth/refresh');
  });

  it('sends the sign-in link request only once the server is up', async () => {
    const done = auth.requestLink('ada@example.com');
    http.expectNone('/api/auth/magic-link');
    http.expectOne('/api/health').flush({});
    await settle();
    http.expectOne('/api/auth/magic-link').flush({}, { status: 202, statusText: 'Accepted' });
    await done;
  });

  it('fails the link request clearly when the server never wakes', async () => {
    // Capture the outcome right away so the rejection is never unhandled while we wait.
    const outcome = auth.requestLink('ada@example.com').then(
      () => null,
      (error: unknown) => error,
    );
    for (let i = 0; i < 20; i++) {
      http.match('/api/health').forEach((r) => r.flush(null, { status: 502, statusText: 'Bad Gateway' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await outcome).toBeInstanceOf(ServerUnavailableError);
    http.expectNone('/api/auth/magic-link');
  });
});
