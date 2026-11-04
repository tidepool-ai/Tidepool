import { HttpTestingController } from '@angular/common/http/testing';
import { AuthService, AuthUser } from '../app/core/auth/auth.service';

export const USER: AuthUser = { id: 'u-1', email: 'ada@example.com' };

/** Let pending promise callbacks run (HTTP calls inside async methods start after a microtask). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

export function tokenResponse(token = 'access-1') {
  return { access_token: token, token_type: 'bearer', expires_in: 900 };
}

/** Sign in through the real AuthService, answering its HTTP calls. */
export async function signIn(auth: AuthService, http: HttpTestingController, user = USER): Promise<void> {
  const done = auth.verify('link-token');
  http.expectOne('/api/auth/verify').flush(tokenResponse());
  await settle();
  http.expectOne('/api/auth/me').flush(user);
  await done;
}

/** Answer the guard's session check as "no session" (refresh cookie missing or expired). */
export function rejectRefresh(http: HttpTestingController): void {
  http.expectOne('/api/auth/refresh').flush({ detail: 'nope' }, { status: 401, statusText: 'Unauthorized' });
}
