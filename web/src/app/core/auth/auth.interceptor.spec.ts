import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { rejectRefresh, settle, signIn, tokenResponse, provideAwakeServer } from '../../../testing/auth-testing';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('authInterceptor', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  let auth: AuthService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideAwakeServer()],
    });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    await signIn(auth, http);
  });

  afterEach(() => http.verify());

  it('adds the access token to API calls', async () => {
    const done = firstValueFrom(client.get('/api/pages'));
    const request = http.expectOne('/api/pages');
    expect(request.request.headers.get('Authorization')).toBe('Bearer access-1');
    request.flush([]);
    await done;
  });

  it('does not send the token to other origins or to auth endpoints', async () => {
    const other = firstValueFrom(client.get('https://example.com/data'));
    const external = http.expectOne('https://example.com/data');
    expect(external.request.headers.has('Authorization')).toBe(false);
    external.flush({});
    await other;

    const refresh = auth.refresh();
    const request = http.expectOne('/api/auth/refresh');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush(tokenResponse('access-2'));
    await refresh;
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    const done = firstValueFrom(client.get('/api/pages'));
    http.expectOne('/api/pages').flush(null, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/auth/refresh').flush(tokenResponse('access-2'));
    await settle();
    const retry = http.expectOne('/api/pages');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer access-2');
    retry.flush(['page']);

    expect(await done).toEqual(['page']);
  });

  it('signs out and fails the call when the refresh fails', async () => {
    const done = firstValueFrom(client.get('/api/pages'));
    http.expectOne('/api/pages').flush(null, { status: 401, statusText: 'Unauthorized' });
    rejectRefresh(http);

    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(auth.isSignedIn()).toBe(false);
  });

  it('passes other errors through without refreshing', async () => {
    const done = firstValueFrom(client.get('/api/pages'));
    http.expectOne('/api/pages').flush(null, { status: 500, statusText: 'Server Error' });
    await expect(done).rejects.toMatchObject({ status: 500 });
    http.expectNone('/api/auth/refresh');
  });
});
