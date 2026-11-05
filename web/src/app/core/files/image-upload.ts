import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** Image types the API accepts (no SVG: it can carry scripts). */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
/** Largest image, matching the API's limit (25 MB). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Uploads one image and resolves with the URL to show it from. `onProgress` gets 0..1. */
export type ImageUploader = (file: File, onProgress: (fraction: number) => void) => Promise<string>;

/** An upload that failed, with a message for people. `retryable` is false when trying again can't help. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Why `file` can't be uploaded, or null if it can. */
export function imageProblem(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_IMAGE_BYTES) return 'Images can be up to 25 MB.';
  return null;
}

/** Sends a form and reports upload progress (0..1). */
export type FormPoster = (url: string, form: FormData, onProgress: (fraction: number) => void) => Promise<void>;

/** XMLHttpRequest, because fetch can't report upload progress. */
export function postFormWithProgress(
  url: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = createRequest();
    request.open('POST', url);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else if (request.status === 400 || request.status === 403) {
        reject(new UploadError('The storage service refused the file.', false));
      } else reject(new UploadError(`The upload failed (error ${request.status}). Try again.`));
    });
    request.addEventListener('error', () => reject(new UploadError('Network error. Check your connection and try again.')));
    request.send(form);
  });
}

export const FORM_POSTER = new InjectionToken<FormPoster>('FORM_POSTER', {
  factory: () => (url, form, onProgress) => postFormWithProgress(url, form, onProgress),
});

interface Presign {
  upload_url: string;
  fields: Record<string, string>;
  url: string;
}

function presignError(error: unknown): UploadError {
  if (error instanceof HttpErrorResponse) {
    const detail = typeof error.error?.detail === 'string' ? error.error.detail : null;
    if (error.status === 0) return new UploadError('Network error. Check your connection and try again.');
    // 413/415: the file itself; 409: the page is in the trash; 503: uploads switched off on this server.
    if (detail && [409, 413, 415, 503].includes(error.status)) {
      return new UploadError(detail.endsWith('.') ? detail : `${detail}.`, false);
    }
  }
  return new UploadError("Couldn't start the upload. Try again.");
}

/** Images go straight to object storage with a presigned form from the API (T13). */
@Injectable({ providedIn: 'root' })
export class ImageUploadService {
  private readonly http = inject(HttpClient);
  private readonly post = inject(FORM_POSTER);

  async upload(pageId: string, file: File, onProgress: (fraction: number) => void): Promise<string> {
    const problem = imageProblem(file);
    if (problem) throw new UploadError(problem, false);
    let presign: Presign;
    try {
      presign = await firstValueFrom(
        this.http.post<Presign>('/api/files/presign', {
          page_id: pageId,
          filename: (file.name || 'image').slice(0, 255),
          content_type: file.type,
          size: file.size,
        }),
      );
    } catch (error) {
      throw presignError(error);
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(presign.fields)) form.append(name, value);
    form.append('file', file); // must come last
    await this.post(presign.upload_url, form, onProgress);
    onProgress(1);
    return presign.url;
  }
}
