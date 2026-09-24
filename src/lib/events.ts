// Spec Part 16 — the real-time broadcast layer.
//
// The spec uses Redis pub/sub so that a cron worker in one process can push to
// SSE subscribers in another. This deployment is a single Bun process, so the
// equivalent is an in-process bus: same publish/subscribe contract, same channel
// names, no external broker to operate.
//
// LIMITATION, stated plainly: because the bus lives in process memory, a
// deployment scaled to more than one instance would only push to clients
// connected to the instance that published. Moving to Redis is a drop-in
// replacement of `publish()`/`subscribe()` — the channel names and payload
// shapes are already identical to the spec's.

export type Channel = 'market:update' | 'district:update' | 'deal:new' | 'intelligence:update'

interface Message {
  channel: Channel
  payload: unknown
  ts: number
}

type Listener = (msg: Message) => void

const listeners = new Set<Listener>()

/** Recent messages per channel, so a client that connects mid-stream still gets context. */
const REPLAY_LIMIT = 20
const recent = new Map<Channel, Message[]>()

export function publish(channel: Channel, payload: unknown): void {
  const msg: Message = { channel, payload, ts: Date.now() }

  const buf = recent.get(channel) ?? []
  buf.push(msg)
  if (buf.length > REPLAY_LIMIT) buf.shift()
  recent.set(channel, buf)

  for (const listener of listeners) {
    try { listener(msg) } catch { /* a dead subscriber must not kill the publisher */ }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscriberCount(): number {
  return listeners.size
}

export function recentMessages(channel?: Channel): Message[] {
  if (channel) return recent.get(channel) ?? []
  return [...recent.values()].flat().sort((a, b) => a.ts - b.ts).slice(-REPLAY_LIMIT)
}

/** Readiness probe for the stream endpoint. */
export function streamStatus() {
  return {
    transport: 'sse',
    broker: 'in-process',
    subscribers: listeners.size,
    channels: ['market:update', 'district:update', 'deal:new', 'intelligence:update'] as Channel[],
    buffered: Object.fromEntries([...recent.entries()].map(([k, v]) => [k, v.length])),
  }
}
