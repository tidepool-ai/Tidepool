import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Auth endpoints that use the refresh cookie or no credentials, so they never get a token or a retry. */
const AUTH_ENDPOINTS = ['/api/auth/magic-link', '/api/auth/verify', '/api/auth/refresh', '/api/auth/logout'];

/**
 * Adds the access token to API calls. On a 401 it refreshes once and retries;
 * if the refresh fails the session is cleared, and the shell sends the user to /login.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/') || AUTH_ENDPOINTS.some((url) => request.url.startsWith(url))) {
    return next(request);
  }
  const auth = inject(AuthService);
  const withToken = (req: HttpRequest<unknown>) => {
    const token = auth.accessToken();
    return token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  };

  return next(withToken(request)).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) return throwError(() => error);
      return from(auth.refresh()).pipe(
        switchMap((refreshed) => (refreshed ? next(withToken(request)) : throwError(() => error))),
      );
    }),
  );
};
