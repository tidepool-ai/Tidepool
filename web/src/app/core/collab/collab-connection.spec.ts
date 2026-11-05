import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { WebsocketCollab } from './collab-connection';
import { NO_ACCESS, RealtimeTicket, socketUrl, ticketSocket } from './ticket-socket';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket whose far end is an in-test Yjs server (one Y.Doc), speaking y-websocket's protocol. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static server = new Y.Doc();
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
      // Like the realtime service: greet with step 1, so the client sends what the server lacks.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, FakeSocket.server);
      this.deliver(encoding.toUint8Array(encoder));
    });
  }

  send(data: ArrayBuffer | Uint8Array): void {
    const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
    if (decoding.readVarUint(decoder) !== 0) return; // presence isn't needed here
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, FakeSocket.server, this);
    if (encoding.length(reply) > 1) this.deliver(encoding.toUint8Array(reply));
  }

  deliver(bytes: Uint8Array): void {
    if (this.readyState === 1) this.onmessage?.(new MessageEvent('message', { data: bytes.slice().buffer }));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.(new CloseEvent('close', { code, reason })));
  }

  /** The server (or the network) ends the connection. */
  drop(code = 1006, reason = ''): void {
    this.close(code, reason);
  }
}

describe('socketUrl', () => {
  const ticket = (url: string): RealtimeTicket => ({ ticket: 'a b', url });

  it('uses the API host when the ticket names one', () => {
    expect(socketUrl(ticket('wss://api.example.com/ws/pages/p1'), new URL('https://app.example.com'))).toBe(
      'wss://api.example.com/ws/pages/p1?ticket=a%20b',
    );
  });

  it('otherwise opens the path on this origin, secure when the page is', () => {
    expect(socketUrl(ticket('/ws/pages/p1'), new URL('https://app.example.com'))).toBe('wss://app.example.com/ws/pages/p1?ticket=a%20b');
    expect(socketUrl(ticket('/ws/pages/p1'), new URL('http://localhost:4200'))).toBe('ws://localhost:4200/ws/pages/p1?ticket=a%20b');
  });
});

describe('ticketSocket', () => {
  beforeEach(() => (FakeSocket.all = []));

  it('gets a ticket, then opens the socket and passes its events on', async () => {
    const Socket = ticketSocket(
      async () => ({ ticket: 't1', url: 'ws://api/ws/pages/p1' }),
      (url) => new FakeSocket(url) as unknown as WebSocket,
    );
    const socket = new Socket('ignored');
    const opened = vi.fn();
    socket.onopen = opened;
    expect(socket.readyState).toBe(0);
    await settle();
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://api/ws/pages/p1?ticket=t1']);
    expect(FakeSocket.all[0].binaryType).toBe('arraybuffer');
    await settle();
    expect(opened).toHaveBeenCalled();
    expect(socket.readyState).toBe(socket.OPEN);
  });

  it('closes as "no access" when there is no ticket for the page, and as a drop when offline', async () => {
    const noAccess = new (ticketSocket(() => Promise.reject(null)))('x');
    const offline = new (ticketSocket(() => Promise.reject(new Error('offline'))))('x');
    const codes: number[] = [];
    noAccess.onclose = (event) => codes.push(event.code);
    offline.onclose = (event) => codes.push(event.code);
    await settle();
    expect(codes).toEqual([NO_ACCESS, 1006]);
  });

  it('never opens a socket closed while its ticket was on the way', async () => {
    const socket = new (ticketSocket(
      async () => ({ ticket: 't', url: 'ws://api/x' }),
      (url) => new FakeSocket(url) as unknown as WebSocket,
    ))('x');
    socket.close();
    await settle();
    expect(FakeSocket.all).toEqual([]);
  });
});

describe('WebsocketCollab', () => {
  let tickets: number;
  let collab: WebsocketCollab;

  function connect(getTicket?: () => Promise<RealtimeTicket>): WebsocketCollab {
    collab = new WebsocketCollab(
      'p1',
      getTicket ??
        (async () => {
          tickets++;
          return { ticket: `t${tickets}`, url: 'ws://api/ws/pages/p1' };
        }),
      (url) => new FakeSocket(url) as unknown as WebSocket,
    );
    return collab;
  }

  const current = () => FakeSocket.all.at(-1)!;
  const text = (doc: Y.Doc) => doc.getText('t').toString();

  beforeEach(() => {
    FakeSocket.all = [];
    FakeSocket.server = new Y.Doc();
    tickets = 0;
  });
  afterEach(() => collab?.destroy());

  it('connects, syncs the server copy and sends edits as they are made', async () => {
    FakeSocket.server.getText('t').insert(0, 'from server');
    connect();
    expect(collab.status()).toBe('connecting');
    await vi.waitFor(() => expect(collab.status()).toBe('connected'));
    expect(collab.synced()).toBe(true);
    expect(text(collab.doc)).toBe('from server');

    collab.doc.getText('t').insert(0, 'me + ');
    expect(text(FakeSocket.server)).toBe('me + from server');
    expect(collab.unsynced()).toBe(false);
  });

  it('keeps edits made offline and sends them on reconnect, with a new ticket', async () => {
    connect();
    await vi.waitFor(() => expect(collab.status()).toBe('connected'));
    current().drop();
    await vi.waitFor(() => expect(collab.status()).toBe('offline'));

    collab.doc.getText('t').insert(0, 'offline edit');
    expect(collab.unsynced()).toBe(true);
    expect(text(FakeSocket.server)).toBe('');

    await vi.waitFor(() => expect(collab.status()).toBe('connected'), { timeout: 3000 });
    expect(text(FakeSocket.server)).toBe('offline edit');
    expect(collab.unsynced()).toBe(false);
    expect(tickets).toBe(2);
    expect(current().url).toContain('ticket=t2');
  });

  it('stops for good when the server refuses the page', async () => {
    connect();
    await vi.waitFor(() => expect(collab.status()).toBe('connected'));
    current().drop(NO_ACCESS, 'No access to this page');
    await vi.waitFor(() => expect(collab.status()).toBe('closed'));
    expect(collab.closedReason()).toBe('No access to this page');
    await settle(400);
    expect(FakeSocket.all).toHaveLength(1); // no reconnect
  });

  it('stops when there is no ticket because access is gone', async () => {
    connect(() => Promise.reject(null));
    await vi.waitFor(() => expect(collab.status()).toBe('closed'));
    expect(FakeSocket.all).toEqual([]);
  });
});
