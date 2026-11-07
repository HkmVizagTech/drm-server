// Live updates for the WhatsApp chat screen.
//
// A browser keeps one connection open (Server-Sent Events) and is told the moment something changes -
// a donor wrote, a tick moved, a chat was taken - instead of asking every few seconds. It is a one-way
// push, which is all this needs, and it passes through Railway's proxy like any other request (a
// WebSocket would add a library and an upgrade path for no gain here).
//
// The event only says WHAT changed (which conversation); the screen then asks for the details through
// the normal, access-checked API. So nothing a person may not see travels on this channel.

import type { Response } from 'express';

export interface ChatEvent {
  /** msg: a new message; status: a tick or failure changed; conv: assignment, read state or window changed */
  t: 'msg' | 'status' | 'conv';
  c: string;
}

const clients = new Set<Response>();
let beat: NodeJS.Timeout | null = null;

export function addClient(res: Response): void {
  clients.add(res);
  // Proxies close an idle connection, so say something every 25 seconds.
  if (!beat) {
    beat = setInterval(() => {
      for (const r of clients) r.write(': keep-alive\n\n');
    }, 25000);
    beat.unref();
  }
  res.on('close', () => {
    clients.delete(res);
    if (!clients.size && beat) {
      clearInterval(beat);
      beat = null;
    }
  });
}

export function publish(e: ChatEvent): void {
  if (!clients.size) return;
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const r of clients) {
    try {
      r.write(line);
    } catch {
      clients.delete(r);
    }
  }
}

export const clientCount = (): number => clients.size;
