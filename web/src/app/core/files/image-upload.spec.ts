import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  FORM_POSTER,
  FormPoster,
  ImageUploadService,
  MAX_IMAGE_BYTES,
  UploadError,
  imageProblem,
  postFormWithProgress,
} from './image-upload';

/** A File whose size is `size` without allocating it. */
function fakeFile(name: string, type: string, size = 10): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const PRESIGN = {
  upload_url: 'https://storage.example.com/bucket',
  fields: { key: 'pages/p1/abc.png', policy: 'cG9saWN5', 'Content-Type': 'image/png' },
  url: '/api/files/pages/p1/abc.png',
  key: 'pages/p1/abc.png',
  max_bytes: MAX_IMAGE_BYTES,
  expires_in: 600,
};

describe('imageProblem', () => {
  it('accepts PNG, JPEG, GIF, WebP and AVIF up to 25 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(imageProblem(fakeFile('a', type)), type).toBeNull();
    }
    expect(imageProblem(fakeFile('a.png', 'image/png', 25 * 1024 * 1024))).toBeNull();
  });

  it('rejects other types, empty files and files over 25 MB', () => {
    expect(imageProblem(fakeFile('a.svg', 'image/svg+xml'))).toContain('Only PNG, JPEG');
    expect(imageProblem(fakeFile('a.pdf', 'application/pdf'))).toContain('Only PNG, JPEG');
    expect(imageProblem(fakeFile('a.png', 'image/png', 0))).toBe('The file is empty.');
    expect(imageProblem(fakeFile('a.png', 'image/png', 25 * 1024 * 1024 + 1))).toBe('Images can be up to 25 MB.');
  });
});

describe('ImageUploadService', () => {
  let http: HttpTestingController;
  let service: ImageUploadService;
  let post: ReturnType<typeof vi.fn<FormPoster>>;

  beforeEach(() => {
    post = vi.fn<FormPoster>().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: FORM_POSTER, useValue: post }],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ImageUploadService);
  });

  afterEach(() => http.verify());

  it('asks the API for an upload form, posts the file to storage with progress, and returns the image URL', async () => {
    const progress: number[] = [];
    post.mockImplementation(async (_url, _form, onProgress) => onProgress(0.5));
    const done = service.upload('p1', fakeFile('photo.png', 'image/png', 1234), (f) => progress.push(f));

    const presign = http.expectOne('/api/files/presign');
    expect(presign.request.method).toBe('POST');
    expect(presign.request.body).toEqual({ page_id: 'p1', filename: 'photo.png', content_type: 'image/png', size: 1234 });
    presign.flush(PRESIGN);

    expect(await done).toBe('/api/files/pages/p1/abc.png');
    const [url, form] = post.mock.calls[0];
    expect(url).toBe(PRESIGN.upload_url);
    const entries = [...form.entries()];
    expect(entries.map(([name]) => name)).toEqual(['key', 'policy', 'Content-Type', 'file']); // file last
    expect((entries[3][1] as File).name).toBe('photo.png');
    expect(progress).toEqual([0.5, 1]);
  });

  it('refuses a wrong type or size before calling the API', async () => {
    await expect(service.upload('p1', fakeFile('a.svg', 'image/svg+xml'), () => undefined)).rejects.toMatchObject({
      message: expect.stringContaining('Only PNG'),
      retryable: false,
    });
    await expect(service.upload('p1', fakeFile('a.png', 'image/png', MAX_IMAGE_BYTES + 1), () => undefined)).rejects.toThrow(
      'Images can be up to 25 MB.',
    );
    http.expectNone('/api/files/presign');
  });

  it.each([
    [413, 'Images can be up to 25 MB', 'Images can be up to 25 MB.'],
    [415, 'Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded', 'Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded.'],
    [409, 'Page is in the trash', 'Page is in the trash.'],
    [503, "Image uploads aren't set up on this server", "Image uploads aren't set up on this server."],
  ])('shows the API reason for a %s, without offering to retry', async (status, detail, message) => {
    const done = service.upload('p1', fakeFile('a.png', 'image/png'), () => undefined);
    http.expectOne('/api/files/presign').flush({ detail }, { status, statusText: 'Error' });
    await expect(done).rejects.toMatchObject({ message, retryable: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('offers to retry when the API fails or is unreachable', async () => {
    const failed = service.upload('p1', fakeFile('a.png', 'image/png'), () => undefined);
    http.expectOne('/api/files/presign').flush(null, { status: 500, statusText: 'Error' });
    await expect(failed).rejects.toMatchObject({ message: "Couldn't start the upload. Try again.", retryable: true });

    const offline = service.upload('p1', fakeFile('a.png', 'image/png'), () => undefined);
    http.expectOne('/api/files/presign').error(new ProgressEvent('error'), { status: 0 });
    await expect(offline).rejects.toThrow('Network error');
  });

  it('passes on a storage failure', async () => {
    post.mockRejectedValue(new UploadError('The storage service refused the file.', false));
    const done = service.upload('p1', fakeFile('a.png', 'image/png'), () => undefined);
    const failed = expect(done).rejects.toMatchObject({ retryable: false });
    http.expectOne('/api/files/presign').flush(PRESIGN);
    await failed;
  });
});

describe('postFormWithProgress', () => {
  class FakeXhr {
    static last: FakeXhr;
    status = 0;
    method = '';
    url = '';
    body: unknown = null;
    private readonly listeners = new Map<string, (event: ProgressEvent) => void>();
    readonly upload = {
      addEventListener: (type: string, listener: (event: ProgressEvent) => void) => this.listeners.set(`upload:${type}`, listener),
    };
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    addEventListener(type: string, listener: (event: ProgressEvent) => void) {
      this.listeners.set(type, listener);
    }
    send(body: unknown) {
      this.body = body;
    }
    fire(type: string, init: ProgressEventInit = {}) {
      this.listeners.get(type)?.(new ProgressEvent(type, init));
    }
  }

  const fake = () => new FakeXhr() as unknown as XMLHttpRequest;

  it('POSTs the form, reports upload progress and resolves on success', async () => {
    const form = new FormData();
    const progress: number[] = [];
    const done = postFormWithProgress('https://storage.example.com/b', form, (f) => progress.push(f), fake);
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url, xhr.body]).toEqual(['POST', 'https://storage.example.com/b', form]);
    xhr.fire('upload:progress', { lengthComputable: true, loaded: 25, total: 100 });
    xhr.fire('upload:progress', { lengthComputable: false, loaded: 50, total: 0 }); // ignored
    xhr.status = 204;
    xhr.fire('load');
    await expect(done).resolves.toBeUndefined();
    expect(progress).toEqual([0.25]);
  });

  it('rejects a refused file without retry, other errors with retry', async () => {
    const refused = postFormWithProgress('u', new FormData(), () => undefined, fake);
    FakeXhr.last.status = 403;
    FakeXhr.last.fire('load');
    await expect(refused).rejects.toMatchObject({ message: 'The storage service refused the file.', retryable: false });

    const broken = postFormWithProgress('u', new FormData(), () => undefined, fake);
    FakeXhr.last.status = 500;
    FakeXhr.last.fire('load');
    await expect(broken).rejects.toMatchObject({ message: 'The upload failed (error 500). Try again.', retryable: true });

    const offline = postFormWithProgress('u', new FormData(), () => undefined, fake);
    FakeXhr.last.fire('error');
    await expect(offline).rejects.toMatchObject({ retryable: true });
  });
});
