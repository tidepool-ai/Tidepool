/** Where to open a page's socket, from POST /api/pages/{id}/realtime-ticket. */
export interface RealtimeTicket {
  ticket: string;
  /** Absolute (wss://api-host/ws/pages/{id}) when the API is on another host, else a path. */
  url: string;
}

/** Close code used when there is no ticket: no access to the page (any more). Doesn't reconnect. */
export const NO_ACCESS = 4403;

/** The socket URL for a ticket: absolute as given, or on this origin. */
export function socketUrl(ticket: RealtimeTicket, origin: Location | URL = location): string {
  const base = /^wss?:\/\//.test(ticket.url)
    ? ticket.url
    : `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}${ticket.url}`;
  return `${base}${base.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket.ticket)}`;
}

/**
 * A WebSocket that first fetches a ticket (tickets last a minute, so every connect gets a fresh
 * one), then opens the real socket. It looks like a WebSocket to y-websocket's provider, which
 * creates one per (re)connect. `getTicket` rejecting with `null` means "no access": the socket
 * closes with NO_ACCESS. Any other failure (offline, server asleep) closes it so the provider
 * retries later.
 */
export function ticketSocket(
  getTicket: () => Promise<RealtimeTicket>,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
): typeof WebSocket {
  class TicketSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    binaryType: BinaryType = 'arraybuffer';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private socket: WebSocket | null = null;
    private abandoned = false;

    constructor() {
      getTicket().then(
        (ticket) => this.open(socketUrl(ticket)),
        (error: unknown) => this.finish(error === null ? NO_ACCESS : 1006, error === null ? 'No access' : 'No ticket'),
      );
    }

    private open(url: string): void {
      if (this.abandoned) return;
      const socket = createSocket(url);
      socket.binaryType = this.binaryType;
      socket.onopen = (event) => {
        this.readyState = this.OPEN;
        this.onopen?.(event);
      };
      socket.onmessage = (event) => this.onmessage?.(event);
      socket.onerror = (event) => this.onerror?.(event);
      socket.onclose = (event) => {
        this.readyState = this.CLOSED;
        this.onclose?.(event);
      };
      this.socket = socket;
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.CLOSED;
      if (!this.abandoned) this.onclose?.(new CloseEvent('close', { code, reason }));
    }

    send(data: Parameters<WebSocket['send']>[0]): void {
      this.socket?.send(data);
    }

    close(code?: number, reason?: string): void {
      this.abandoned = true;
      if (this.socket) this.socket.close(code, reason);
      else this.readyState = this.CLOSED;
    }
  }
  return TicketSocket as unknown as typeof WebSocket;
}
