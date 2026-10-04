/**
 * Server-side enforcement of the session limit.
 *
 * The product rule is "two devices per session, ever": one host and one viewer. These tests
 * drive the real signalling server over real WebSockets, because that is where the rule has
 * to hold - a UI-level check would be trivially bypassable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const SERVER = path.join(__dirname, '..', 'server', 'signal.js');
const PASSWORD_HASH = crypto.createHash('sha256').update('peerlink:v1:246813').digest('hex');

let server: ChildProcess;
let port = 0;

/** A scripted client that records everything the server says to it. */
class TestClient {
  readonly messages: Record<string, unknown>[] = [];
  private ws!: WebSocket;
  closed: { code?: number; reason?: string } | null = null;

  static async connect(port: number): Promise<TestClient> {
    const client = new TestClient();
    client.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.ws.on('message', (raw) => client.messages.push(JSON.parse(raw.toString())));
    client.ws.on('close', (code, reason) => {
      client.closed = { code, reason: reason.toString() };
    });
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', () => resolve());
      client.ws.once('error', reject);
    });
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(type: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
    const found = await this.waitForCount(type, 1, timeoutMs);
    return found[0];
  }

  /** Waits until at least `count` messages of a type have arrived, then returns them all. */
  async waitForCount(type: string, count: number, timeoutMs = 4000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.filter((m) => m.t === type);
      if (found.length >= count) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count}x "${type}"; saw ${JSON.stringify(this.messages.map((m) => m.t))}`
        );
      }
      await sleep(20);
    }
  }

  /**
   * Waits until the newest message of `type` satisfies `predicate`. Robust against the
   * host legitimately seeing several `viewer-joined` events in one session.
   */
  async waitForValue(
    type: string,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 4000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> | undefined;
    for (;;) {
      const found = this.messages.filter((m) => m.t === type);
      last = found[found.length - 1];
      if (last && predicate(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for "${type}" matching predicate; newest was ${JSON.stringify(last)}`
        );
      }
      await sleep(20);
    }
  }

  has(type: string): boolean {
    return this.messages.some((m) => m.t === type);
  }

  clear(): void {
    this.messages.length = 0;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a host and returns its code. */
async function startHost(): Promise<TestClient> {
  const host = await TestClient.connect(port);
  await host.waitFor('hello');
  host.send({ t: 'host', protocol: 1, passwordHash: PASSWORD_HASH, hostName: 'test-host' });
  const ok = await host.waitFor('host-ok');
  host.clear();
  (host as TestClient & { code?: string }).code = String(ok.code);
  return host;
}

const codeOf = (host: TestClient) => (host as TestClient & { code: string }).code;

async function joinViewer(code: string, name: string): Promise<TestClient> {
  const viewer = await TestClient.connect(port);
  await viewer.waitFor('hello');
  viewer.send({ t: 'join', code, passwordHash: PASSWORD_HASH, viewerName: name, protocol: 1 });
  await viewer.waitFor('join-ok');
  return viewer;
}

beforeAll(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('signalling server did not start');
});

afterAll(() => {
  server?.kill();
});

describe('session capacity', () => {
  it('advertises the two-device limit in /health', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as { maxViewersPerRoom: number };
    expect(body.maxViewersPerRoom).toBe(1);
  });

  it('tells both sides the limit when a session starts', async () => {
    const host = await TestClient.connect(port);
    await host.waitFor('hello');
    host.send({ t: 'host', protocol: 1, passwordHash: PASSWORD_HASH, hostName: 'limit-host' });
    const ok = await host.waitFor('host-ok');
    expect(ok.maxViewers).toBe(1);

    const viewer = await joinViewer(String(ok.code), 'first');
    expect((await viewer.waitFor('join-ok', 500)).maxViewers ?? 1).toBe(1);
    viewer.close();
    host.close();
  });

  it('evicts the first viewer when a second one joins', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const first = await joinViewer(code, 'first');
    expect(first.has('replaced')).toBe(false);

    const second = await joinViewer(code, 'second');

    // The newcomer is told its slot number; the incumbent is told it lost the slot.
    const secondOk = await second.waitFor('join-ok', 500);
    expect(Number(secondOk.seq), 'second viewer slot').toBe(2);
    await first.waitFor('replaced');
    expect(String((first.messages.find((m) => m.t === 'replaced') as { reason: string }).reason)).toBe(
      'another-viewer-connected'
    );

    // The host is told about the newcomer with the same slot the viewer was given.
    const joined = await host.waitForValue('viewer-joined', (m) => Number(m.seq) === 2);
    expect(Number(joined.seq), 'host viewer-joined slot').toBe(2);

    // And the evicted viewer's socket is actually closed, not just detached.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !first.closed) await sleep(50);
    expect(first.closed).not.toBeNull();

    second.close();
    host.close();
  });

  it('never lets a third device hold a slot at the same time', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const a = await joinViewer(code, 'a');
    const b = await joinViewer(code, 'b');
    const c = await joinViewer(code, 'c');

    // Exactly one of them still has a live socket; the other two were evicted.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const live = [a, b, c].filter((client) => client.closed === null);
      if (live.length === 1) break;
      await sleep(50);
    }
    const live = [a, b, c].filter((client) => client.closed === null);
    expect(live.length).toBe(1);
    expect(live[0]).toBe(c);
    expect(a.closed).not.toBeNull();
    expect(b.closed).not.toBeNull();

    c.close();
    host.close();
  });

  it('refuses signals from an evicted viewer instead of relaying them', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const first = await joinViewer(code, 'first');
    const firstSeq = Number((first.messages.find((m) => m.t === 'join-ok') as { seq: number }).seq);

    const second = await joinViewer(code, 'second');
    const secondSeq = Number((second.messages.find((m) => m.t === 'join-ok') as { seq: number }).seq);
    expect(secondSeq).toBeGreaterThan(firstSeq);

    host.clear();

    // Both viewers try to send SDP at the same moment - the classic race when someone
    // takes a session over while the previous viewer is still mid-handshake.
    first.send({ t: 'signal', payload: { kind: 'offer', from: 'viewer', sdp: 'stale' } });
    second.send({ t: 'signal', payload: { kind: 'offer', from: 'viewer', sdp: 'fresh' } });

    const relayed = await host.waitFor('signal');
    await sleep(300);

    const payloads = host.messages.filter((m) => m.t === 'signal').map((m) => (m.payload as { sdp: string }).sdp);
    expect(payloads).toContain('fresh');
    expect(payloads).not.toContain('stale');
    expect((relayed.payload as { sdp: string }).sdp).toBe('fresh');

    // The evicted viewer is told why its signal went nowhere.
    await first.waitFor('error');
    const codes = first.messages.filter((m) => m.t === 'error').map((m) => m.code);
    expect(codes).toContain('stale-viewer');

    second.close();
    host.close();
  });

  it('drops host signals stamped with a superseded viewer slot', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const first = await joinViewer(code, 'first');
    const firstSeq = Number((first.messages.find((m) => m.t === 'join-ok') as { seq: number }).seq);

    const second = await joinViewer(code, 'second');
    const secondSeq = Number((second.messages.find((m) => m.t === 'join-ok') as { seq: number }).seq);
    expect(secondSeq).toBeGreaterThan(firstSeq);

    // The host's previous peer connection is still emitting ICE for the old slot while the new
    // viewer negotiates. Those candidates must not be relayed: the newcomer would otherwise
    // accept a candidate that belongs to a negotiation it is not part of.
    host.send({ t: 'signal', seq: firstSeq, payload: { kind: 'ice', from: 'host', candidate: { candidate: 'stale' } } });
    host.send({ t: 'signal', seq: secondSeq, payload: { kind: 'ice', from: 'host', candidate: { candidate: 'fresh' } } });
    await sleep(300);

    const candidates = second.messages
      .filter((m) => m.t === 'signal')
      .map((m) => (m.payload as { candidate?: { candidate?: string } }).candidate?.candidate);
    expect(candidates).toContain('fresh');
    expect(candidates).not.toContain('stale');

    // An unversioned host signal still works, so an older build keeps interoperating.
    host.send({ t: 'signal', payload: { kind: 'ice', from: 'host', candidate: { candidate: 'unversioned' } } });
    await sleep(200);
    const after = second.messages
      .filter((m) => m.t === 'signal')
      .map((m) => (m.payload as { candidate?: { candidate?: string } }).candidate?.candidate);
    expect(after).toContain('unversioned');

    second.close();
    host.close();
  });

  it('ignores a leave-room from a viewer that was already replaced', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const first = await joinViewer(code, 'first');
    const second = await joinViewer(code, 'second');
    void second;

    host.clear();
    // The evicted viewer says goodbye late; the host must not tear down viewer #2.
    first.send({ t: 'leave-room' });
    await sleep(300);
    expect(host.has('viewer-gone')).toBe(false);

    second.close();
    host.close();
  });

  it('lets the freed slot be taken again after a viewer leaves', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const first = await joinViewer(code, 'first');
    first.send({ t: 'leave-room' });
    const gone = await host.waitFor('viewer-gone');
    expect(gone.reason).toBe('viewer-left');

    // Slot numbers identify a viewer session and only move forward, so the next viewer
    // gets a higher slot rather than reusing the vacated one.
    const second = await joinViewer(code, 'second');
    const secondOk = await second.waitFor('join-ok', 500);
    const slot = Number(secondOk.seq);
    expect(slot).toBeGreaterThan(Number(gone.seq));

    const joined = await host.waitForValue('viewer-joined', (m) => Number(m.seq) === slot);
    expect(Number(joined.seq), 'host slot after re-join').toBe(slot);

    second.close();
    host.close();
  });

  it('still requires the password before a slot is granted', async () => {
    const host = await startHost();
    const code = codeOf(host);

    const attacker = await TestClient.connect(port);
    await attacker.waitFor('hello');
    attacker.send({
      t: 'join',
      code,
      viewerName: 'attacker',
      passwordHash: crypto.createHash('sha256').update('peerlink:v1:000000').digest('hex'),
      protocol: 1
    });
    const failure = await attacker.waitFor('error');
    expect(failure.code).toBe('bad-password');
    expect(attacker.has('join-ok')).toBe(false);

    attacker.close();
    host.close();
  });
});
