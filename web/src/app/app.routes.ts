import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Tidepool',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'auth/verify',
    title: 'Signing in · Tidepool',
    loadComponent: () => import('./features/auth/verify.page').then((m) => m.VerifyPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      {
        path: 'home',
        title: 'Home · Tidepool',
        loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage),
      },
      {
        path: 'p/:pageId',
        title: 'Page · Tidepool',
        loadComponent: () => import('./features/page/page.page').then((m) => m.PagePage),
      },
      {
        path: 'settings/appearance',
        title: 'Appearance · Tidepool',
        loadComponent: () => import('./features/settings/appearance.page').then((m) => m.AppearancePage),
      },
    ],
  },
  { path: '**', redirectTo: 'home' },
];
