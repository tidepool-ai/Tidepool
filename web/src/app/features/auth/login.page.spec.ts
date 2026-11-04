import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { settle } from '../../../testing/auth-testing';
import { LoginPage } from './login.page';

describe('LoginPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render(returnUrl?: string) {
    const fixture = TestBed.createComponent(LoginPage);
    if (returnUrl) fixture.componentRef.setInput('returnUrl', returnUrl);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('input')!;
    const submit = async (email: string) => {
      input.value = email;
      input.dispatchEvent(new Event('input'));
      element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    };
    return { fixture, element, input, submit };
  }

  it('has a labelled email field and a real submit button', async () => {
    const { element, input } = await render();
    expect(element.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('Email');
    expect(input.type).toBe('email');
    expect(input.required).toBe(true);
    expect(element.querySelector('button[type="submit"]')?.textContent).toContain('Send sign-in link');
  });

  it('requests a magic link and confirms it was sent', async () => {
    const { fixture, element, submit } = await render('/p/abc');
    await submit('  ada@example.com ');

    const request = http.expectOne('/api/auth/magic-link');
    expect(request.request.body).toEqual({ email: 'ada@example.com' });
    request.flush({}, { status: 202, statusText: 'Accepted' });
    await settle();
    await fixture.whenStable();

    expect(element.querySelector('[role="status"]')?.textContent).toContain('ada@example.com');
    expect(localStorage.getItem('tidepool.returnUrl')).toBe('/p/abc');
  });

  it('shows an error when the request fails', async () => {
    const { fixture, element, input, submit } = await render();
    await submit('ada@example.com');
    http.expectOne('/api/auth/magic-link').flush(null, { status: 500, statusText: 'Server Error' });
    await settle();
    await fixture.whenStable();

    const alert = element.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("couldn't send");
    expect(input.getAttribute('aria-describedby')).toBe(alert?.id);
  });
});
