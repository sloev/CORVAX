// Inboxes: short-lived queues of sealed messages per recipient key, drained by acked long polls.
import { hex } from './bytes.js'
import { sha256 } from './crypto.js'

const INBOX_TTL = 120e3, INBOX_MAX = 64, INBOX_BYTES = 1 << 20, POLL_MAX = 25e3   // per recipient: ≤ 64 messages, ≤ 1 MB

export class Inboxes {
  constructor () { this.boxes = new Map() }
  #box (k) {
    const id = hex(k)
    if (!this.boxes.has(id)) this.boxes.set(id, { seq: 0, msgs: [], waiter: null })
    const box = this.boxes.get(id), now = Date.now()
    box.msgs = box.msgs.filter(m => now - m.t < INBOX_TTL)
    return box
  }
  async put (to, msg) {
    const box = this.#box(to), h = hex(await sha256(msg))
    if (!box.msgs.some(m => m.h === h)) {                              // retries are idempotent
      box.seq = Math.max(box.seq + 1, Date.now())                    // rises across restarts: a client's `after` stays valid
      box.msgs.push({ seq: box.seq, msg, h, t: Date.now() })
      while (box.msgs.length > INBOX_MAX || box.msgs.reduce((n, m) => n + m.msg.length, 0) > INBOX_BYTES) box.msgs.shift()
    }
    box.waiter?.(); box.waiter = null
  }
  async listen (k, after, signal) {
    const box = this.#box(k)
    box.msgs = box.msgs.filter(m => m.seq > after)                      // acknowledged → deleted
    if (!box.msgs.length && !signal?.aborted) {
      box.waiter?.()                                                    // a newer poll ends the older one
      await new Promise(resolve => {
        const timer = setTimeout(done, POLL_MAX)
        function done () { clearTimeout(timer); signal?.removeEventListener('abort', done); if (box.waiter === done) box.waiter = null; resolve() }
        box.waiter = done
        signal?.addEventListener('abort', done)
      })
    }
    return box.msgs.map(m => ({ seq: m.seq, msg: m.msg }))
  }
  close () { for (const box of this.boxes.values()) box.waiter?.() }
  sweep () {
    const now = Date.now()
    for (const [id, box] of this.boxes) {
      box.msgs = box.msgs.filter(m => now - m.t < INBOX_TTL)
      if (!box.msgs.length && !box.waiter) this.boxes.delete(id)
    }
  }
}
