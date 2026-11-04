import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Lets signed-in users through; sends everyone else to /login, remembering where they were going. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  if (await inject(AuthService).ensureSession()) return true;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Keeps signed-in users off the login page. */
export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AuthService).ensureSession()) ? router.createUrlTree(['/home']) : true;
};

/** Only allow in-app paths as a post-login destination, so links can't redirect off-site. */
export function safeReturnUrl(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/home';
}
