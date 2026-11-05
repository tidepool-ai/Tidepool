import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { InjectionToken, Signal, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { NO_ACCESS, RealtimeTicket, ticketSocket } from './ticket-socket';

/**
 * connecting: first connection (or reconnecting after a drop, before ever syncing).
 * connected: synced with the server; edits go out as they're made.
 * offline: the connection dropped; edits are kept and sent when it's back.
 * closed: the server refused the page (no access, or an edit on a read-only page). No retries.
 */
export type CollabStatus = 'connecting' | 'connected' | 'offline' | 'closed';

/** A page's live document (T15), shared with everyone who has the page open. */
export interface CollabConnection {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly status: Signal<CollabStatus>;
  /** True once the server's copy has been received (since the page was opened). */
  readonly synced: Signal<boolean>;
  /** Local edits the server hasn't seen yet (made while offline). */
  readonly unsynced: Signal<boolean>;
  /** Why the server closed the page for good, if it did. */
  readonly closedReason: Signal<string | null>;
  destroy(): void;
}

export type CollabConnector = (pageId: string) => CollabConnection;

/** Close codes after which reconnecting can't help (see docs/REALTIME.md). */
const FINAL_CLOSES = new Set([NO_ACCESS, 1009]);

/** y-websocket's provider, with a fresh ticket per connect and the state as signals. */
export class WebsocketCollab implements CollabConnection {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  private readonly provider: WebsocketProvider;
  private readonly state = signal<CollabStatus>('connecting');
  private readonly hasSynced = signal(false);
  private readonly pending = signal(false);
  private readonly closedWith = signal<string | null>(null);
  readonly status = this.state.asReadonly();
  readonly synced = this.hasSynced.asReadonly();
  readonly unsynced = this.pending.asReadonly();
  readonly closedReason = this.closedWith.asReadonly();

  constructor(pageId: string, getTicket: () => Promise<RealtimeTicket>, createSocket?: (url: string) => WebSocket) {
    this.provider = new WebsocketProvider('ws://unused', pageId, this.doc, {
      WebSocketPolyfill: ticketSocket(getTicket, createSocket),
      // Ask the server for changes now and then, so a quiet page isn't taken for a dead connection.
      resyncInterval: 10_000,
      disableBc: true,
      maxBackoffTime: 10_000,
      shouldReconnect: (event: CloseEvent) => !FINAL_CLOSES.has(event.code),
    });
    this.awareness = this.provider.awareness;
    this.provider.on('sync', (synced: boolean) => {
      if (!synced) return;
      this.hasSynced.set(true);
      this.pending.set(false);
      this.state.set('connected');
    });
    this.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'disconnected' && this.state() !== 'closed') this.state.set('offline');
    });
    this.provider.on('connection-close', (event: CloseEvent | null) => {
      if (event && FINAL_CLOSES.has(event.code)) {
        this.closedWith.set(event.reason || 'Closed');
        this.state.set('closed');
      } else if (this.state() === 'connected') {
        this.state.set('offline');
      }
    });
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider && this.state() !== 'connected') this.pending.set(true);
    });
  }

  private destroyed = false;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.destroy();
    this.doc.destroy();
  }
}

/** Opens pages' live documents through the API (tests swap in an in-memory one). */
export const COLLAB_CONNECTOR = new InjectionToken<CollabConnector>('COLLAB_CONNECTOR', {
  factory: () => {
    const http = inject(HttpClient);
    return (pageId) =>
      new WebsocketCollab(pageId, async () => {
        try {
          return await firstValueFrom(http.post<RealtimeTicket>(`/api/pages/${pageId}/realtime-ticket`, null));
        } catch (error) {
          // No access (404) or signed out (401 after a failed refresh): stop. Anything else: retry later.
          throw error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status) ? null : error;
        }
      });
  },
});
