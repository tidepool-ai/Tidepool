import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ServerWake, WAKE_OPTIONS, WakeOptions } from './server-wake';

const FAST: WakeOptions = { intervalMs: 5, giveUpAfterMs: 60, attemptTimeoutMs: 1000, freshForMs: 60_000, showAfterMs: 20 };
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('ServerWake', () => {
  let http: HttpTestingController;
  let wake: ServerWake;

  function setup(options: Partial<WakeOptions> = {}) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: WAKE_OPTIONS, useValue: { ...FAST, ...options } }],
    });
    http = TestBed.inject(HttpTestingController);
    wake = TestBed.inject(ServerWake);
  }

  const health = () => http.expectOne('/api/health');
  const asleep = (status: number) => health().flush(null, { status, statusText: 'Gateway' });

  afterEach(() => http.verify());

  it('defaults to checking every 3 s for up to 90 s', () => {
    setup();
    TestBed.resetTestingModule();
    expect(TestBed.inject(WAKE_OPTIONS)).toMatchObject({ intervalMs: 3000, giveUpAfterMs: 90_000 });
  });

  it('is ready as soon as /api/health answers, without showing anything', async () => {
    setup();
    const ready = wake.ready();
    health().flush({ status: 'ok' });
    expect(await ready).toBe(true);
    expect(wake.waking()).toBe(false);
    expect(wake.isAwake()).toBe(true);
  });

  it('skips the check while the last answer is fresh', async () => {
    setup();
    const first = wake.ready();
    health().flush({});
    await first;
    expect(await wake.ready()).toBe(true);
    http.expectNone('/api/health');
  });

  it.each([0, 502, 503, 504])('keeps checking while the server answers %s, showing that it is waking up', async (status) => {
    setup();
    const ready = wake.ready();
    asleep(status);
    await tick();
    expect(wake.waking()).toBe(true);

    await tick(FAST.intervalMs + 5);
    health().flush({});
    expect(await ready).toBe(true);
    expect(wake.waking()).toBe(false);
  });

  it('treats any other answer as awake (the API is up, even if unhappy)', async () => {
    setup();
    const ready = wake.ready();
    health().flush(null, { status: 500, statusText: 'Error' });
    expect(await ready).toBe(true);
  });

  it('shows the notice when a single check is slow, as on a cold start', async () => {
    setup();
    const ready = wake.ready();
    await tick(FAST.showAfterMs + 10);
    expect(wake.waking()).toBe(true);
    health().flush({});
    await ready;
    expect(wake.waking()).toBe(false);
  });

  it('gives up after the limit', async () => {
    setup();
    const ready = wake.ready();
    for (let i = 0; i < 50; i++) {
      const pending = http.match('/api/health');
      pending.forEach((request) => request.flush(null, { status: 503, statusText: 'Starting' }));
      if (!pending.length && i > 0) {
        await tick(FAST.intervalMs);
        if (!http.match('/api/health').length) break;
      }
      await tick(FAST.intervalMs);
    }
    expect(await ready).toBe(false);
    expect(wake.waking()).toBe(false);
    expect(wake.isAwake()).toBe(false);
    http.match('/api/health').forEach((request) => request.flush({}));
  });

  it('shares one wait between concurrent callers', async () => {
    setup();
    const a = wake.ready();
    const b = wake.ready();
    health().flush({});
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });
});
