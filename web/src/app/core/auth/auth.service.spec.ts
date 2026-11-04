import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { USER, rejectRefresh, settle, signIn, tokenResponse } from '../../../testing/auth-testing';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('requests a magic link for an email', async () => {
    const done = auth.requestLink('ada@example.com');
    const request = http.expectOne('/api/auth/magic-link');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'ada@example.com' });
    request.flush({ detail: 'ok' }, { status: 202, statusText: 'Accepted' });
    await done;
  });

  it('verifies a link, keeps the access token in memory and loads the user', async () => {
    const done = auth.verify('link-token');
    const verify = http.expectOne('/api/auth/verify');
    expect(verify.request.body).toEqual({ token: 'link-token' });
    verify.flush(tokenResponse('access-1'));
    await settle();
    http.expectOne('/api/auth/me').flush(USER);
    await done;

    expect(auth.accessToken()).toBe('access-1');
    expect(auth.user()).toEqual(USER);
    expect(auth.isSignedIn()).toBe(true);
  });

  it('rejects an invalid link and stays signed out', async () => {
    const done = auth.verify('bad');
    http.expectOne('/api/auth/verify').flush({ detail: 'invalid' }, { status: 401, statusText: 'Unauthorized' });
    await expect(done).rejects.toBeTruthy();
    expect(auth.isSignedIn()).toBe(false);
  });

  it('restores a session from the refresh cookie', async () => {
    const done = auth.ensureSession();
    http.expectOne('/api/auth/refresh').flush(tokenResponse('access-2'));
    await settle();
    http.expectOne('/api/auth/me').flush(USER);

    expect(await done).toBe(true);
    expect(auth.accessToken()).toBe('access-2');
  });

  it('reports no session when the refresh cookie is missing or expired', async () => {
    const done = auth.ensureSession();
    rejectRefresh(http);
    expect(await done).toBe(false);
    expect(auth.isSignedIn()).toBe(false);
  });

  it('remembers there is no session until the next sign-in', async () => {
    const first = auth.ensureSession();
    rejectRefresh(http);
    expect(await first).toBe(false);

    expect(await auth.ensureSession()).toBe(false);
    http.expectNone('/api/auth/refresh');

    await signIn(auth, http);
    expect(await auth.ensureSession()).toBe(true);
  });

  it('checks again after a network error instead of assuming signed out', async () => {
    const first = auth.ensureSession();
    http.expectOne('/api/auth/refresh').error(new ProgressEvent('offline'));
    expect(await first).toBe(false);

    const second = auth.ensureSession();
    http.expectOne('/api/auth/refresh').flush(tokenResponse());
    await settle();
    http.expectOne('/api/auth/me').flush(USER);
    expect(await second).toBe(true);
  });

  it('does not call the server again once signed in', async () => {
    await signIn(auth, http);
    expect(await auth.ensureSession()).toBe(true);
    http.expectNone('/api/auth/refresh');
  });

  it('shares one refresh request between concurrent callers', async () => {
    const first = auth.refresh();
    const second = auth.refresh();
    http.expectOne('/api/auth/refresh').flush(tokenResponse('access-3'));
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it('clears the session when a refresh fails', async () => {
    await signIn(auth, http);
    const done = auth.refresh();
    rejectRefresh(http);
    expect(await done).toBe(false);
    expect(auth.accessToken()).toBeNull();
    expect(auth.isSignedIn()).toBe(false);
  });

  it('logs out on the server and clears the session', async () => {
    await signIn(auth, http);
    const done = auth.logout();
    const request = http.expectOne('/api/auth/logout');
    expect(request.request.method).toBe('POST');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(auth.isSignedIn()).toBe(false);
  });

  it('clears the session even if the logout call fails', async () => {
    await signIn(auth, http);
    const done = auth.logout();
    http.expectOne('/api/auth/logout').error(new ProgressEvent('network'));
    await done;
    expect(auth.isSignedIn()).toBe(false);
  });
});
