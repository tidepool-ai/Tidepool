import { Autosave } from './autosave';

/** A save function whose calls can be resolved or rejected by the test. */
function controllableSave() {
  const calls: { value: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const save = vi.fn(
    (value: string) => new Promise<void>((resolve, reject) => calls.push({ value, resolve, reject })),
  );
  return { save, calls };
}

describe('Autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a 1 second pause, then saves only the latest value', async () => {
    const { save, calls } = controllableSave();
    const autosave = new Autosave<string>(save);

    autosave.change('H');
    await vi.advanceTimersByTimeAsync(600);
    autosave.change('He');
    await vi.advanceTimersByTimeAsync(600);
    autosave.change('Hey');
    expect(save).not.toHaveBeenCalled();
    expect(autosave.status()).toBe('pending');

    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].value).toBe('Hey');
    expect(autosave.status()).toBe('saving');
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(autosave.status()).toBe('saved');
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  it('starts idle and does nothing on flush without changes', async () => {
    const { save } = controllableSave();
    const autosave = new Autosave<string>(save);
    expect(autosave.status()).toBe('idle');
    await autosave.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('runs one save at a time and saves edits made during a save afterwards', async () => {
    const { save, calls } = controllableSave();
    const autosave = new Autosave<string>(save);
    autosave.change('a');
    await vi.advanceTimersByTimeAsync(1000);

    autosave.change('ab');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1); // still waiting for the first save
    expect(autosave.hasUnsavedChanges).toBe(true);

    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1].value).toBe('ab');
    calls[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(autosave.status()).toBe('saved');
  });

  it('keeps the edit as unsaved after a failure and saves it on retry or the next edit', async () => {
    const { save, calls } = controllableSave();
    const autosave = new Autosave<string>(save);
    autosave.change('draft');
    await vi.advanceTimersByTimeAsync(1000);
    const failure = new Error('offline');
    calls[0].reject(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(autosave.status()).toBe('error');
    expect(autosave.error()).toBe(failure);
    expect(autosave.hasUnsavedChanges).toBe(true);

    const retry = autosave.flush();
    expect(calls[1].value).toBe('draft');
    calls[1].reject(failure);
    await retry;

    autosave.change('draft 2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[2].value).toBe('draft 2');
    calls[2].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(autosave.status()).toBe('saved');
    expect(autosave.error()).toBeNull();
  });

  it('flush saves pending edits right away', async () => {
    const { save, calls } = controllableSave();
    const autosave = new Autosave<string>(save);
    autosave.change('now');
    const flushed = autosave.flush();
    expect(calls[0].value).toBe('now');
    calls[0].resolve();
    await flushed;
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // the debounce timer was cancelled
  });

  it('dispose cancels a pending save', async () => {
    const { save } = controllableSave();
    const autosave = new Autosave<string>(save);
    autosave.change('x');
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});
