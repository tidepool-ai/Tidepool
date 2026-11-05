import { signal } from '@angular/core';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CollabConnection, CollabConnector, CollabStatus } from '../app/core/collab/collab-connection';

/**
 * An in-memory stand-in for the realtime service: one Y.Doc per page, and connections ("tabs") that
 * relay updates and presence through it. Tabs can go offline and come back.
 */
export class FakeCollabServer {
  readonly docs = new Map<string, Y.Doc>();
  readonly connections: FakeConnection[] = [];
  /** Hold the first sync until `release()` (to see "Connecting…"). */
  holdSync = false;
  /** Queue updates between tabs until `deliver()`, like network latency. */
  holdDelivery = false;
  private queue: (() => void)[] = [];

  relay(send: () => void): void {
    if (this.holdDelivery) this.queue.push(send);
    else send();
  }

  deliver(): void {
    this.holdDelivery = false;
    const queued = this.queue;
    this.queue = [];
    queued.forEach((send) => send());
  }

  readonly connector: CollabConnector = (pageId) => {
    const connection = new FakeConnection(this, pageId);
    this.connections.push(connection);
    if (!this.holdSync) queueMicrotask(() => connection.goOnline());
    return connection;
  };

  doc(pageId: string): Y.Doc {
    let doc = this.docs.get(pageId);
    if (!doc) this.docs.set(pageId, (doc = new Y.Doc()));
    return doc;
  }

  /** The page's server copy as text (for asserting what everyone converged on). */
  text(pageId: string): string {
    return this.doc(pageId).getXmlFragment('default').toString();
  }

  release(): void {
    this.holdSync = false;
    for (const connection of this.connections) if (connection.status() === 'connecting') connection.goOnline();
  }

  peers(of: FakeConnection): FakeConnection[] {
    return this.connections.filter((c) => c !== of && c.pageId === of.pageId && c.status() === 'connected');
  }
}

export class FakeConnection implements CollabConnection {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private readonly state = signal<CollabStatus>('connecting');
  private readonly hasSynced = signal(false);
  private readonly pending = signal(false);
  private readonly closedWith = signal<string | null>(null);
  readonly status = this.state.asReadonly();
  readonly synced = this.hasSynced.asReadonly();
  readonly unsynced = this.pending.asReadonly();
  readonly closedReason = this.closedWith.asReadonly();
  destroyed = false;
  /** Updates this tab sent to the server. */
  readonly sent: Uint8Array[] = [];

  constructor(
    private readonly server: FakeCollabServer,
    readonly pageId: string,
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === server) return;
      if (this.state() !== 'connected') {
        this.pending.set(true);
        return;
      }
      this.sent.push(update);
      server.relay(() => {
        Y.applyUpdate(server.doc(pageId), update, this);
        for (const peer of server.peers(this)) Y.applyUpdate(peer.doc, update, server);
      });
    });
    this.awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === server || this.state() !== 'connected') return;
      const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
      for (const peer of server.peers(this)) applyAwarenessUpdate(peer.awareness, update, server);
    });
  }

  /** (Re)connect: exchange what each side is missing, then presence. */
  goOnline(): void {
    if (this.destroyed || this.state() === 'closed') return;
    const serverDoc = this.server.doc(this.pageId);
    const toServer = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(serverDoc));
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(serverDoc, Y.encodeStateVector(this.doc)), this.server);
    this.state.set('connected');
    Y.applyUpdate(serverDoc, toServer, this);
    for (const peer of this.server.peers(this)) Y.applyUpdate(peer.doc, toServer, this.server);
    for (const peer of this.server.peers(this)) {
      const theirs = encodeAwarenessUpdate(peer.awareness, [peer.doc.clientID]);
      applyAwarenessUpdate(this.awareness, theirs, this.server);
      const mine = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
      applyAwarenessUpdate(peer.awareness, mine, this.server);
    }
    this.hasSynced.set(true);
    this.pending.set(false);
  }

  /** The connection drops: others lose this tab's presence, and it loses theirs. */
  goOffline(): void {
    this.state.set('offline');
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    removeAwarenessStates(this.awareness, others, this.server);
    for (const peer of this.server.peers(this)) removeAwarenessStates(peer.awareness, [this.doc.clientID], this.server);
  }

  /** The server refuses the page for good. */
  close(reason: string): void {
    this.goOffline();
    this.closedWith.set(reason);
    this.state.set('closed');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.goOffline();
    this.destroyed = true;
    this.state.set('offline');
  }
}
