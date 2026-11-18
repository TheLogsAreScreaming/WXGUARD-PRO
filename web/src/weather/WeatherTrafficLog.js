// Port of MC1Services/Services/Weather/Screen/WeatherTrafficLog.swift (docs/PORTING.md).
//
// Deviation from the Swift's directory: the Swift keeps `WeatherTrafficEntry` and
// `WeatherTrafficLog` beside the screen rules, where `MC1Services` is one module and the service
// can reach them. The web client's layers are one-way — `weather` never imports `screen`
// (PORTING.md §9) — and `WeatherService` is what writes every row, so the entry and the log live
// here. `WeatherTrafficSummary`, which needs the tables and the string table to word a row, is a
// screen rule and stays in `src/screen/`.
//
// Owner, 20 September 2026: *"A way to see all the GRP_DATA traffic on a channel like we do a
// chat."* That is what this is: a plain record of what went past on `#meshwx`, kept because the
// alternative was reading a console log over somebody's shoulder.

import { bytesToHex, decodeHeader, MeshWXWire } from '../meshwx/index.js'

/**
 * One datagram on the weather channel, in or out (docs/MESHWX_UI.md §17):
 *
 * `{ id, at, direction, isBacklog, channelIndex, dataType, botID, seq, type, flags, length,
 * snr, pathLength, hex, isDuplicate }`
 *
 * Everything the header said is kept *as read*, and the whole payload as hex, because the point
 * of the screen is the traffic and not this app's opinion of it: a datagram the codec could not
 * read is exactly the one worth being able to look at. The header fields are null for such a
 * one, and for a datagram of another `data_type` that happened to be on the slot.
 *
 * - `direction`: `'received'` for anything the radio delivered, `'sent'` for a Request datagram
 *   this device put on the air. A DM is not here: it is not a datagram and nobody else saw it.
 * - `isBacklog`: drained from the radio's queue at connect rather than heard live. It can be
 *   hours old and says nothing about whether the bot is in range now.
 * - `isDuplicate`: the reducer recognised it as a copy of a message already applied — the bot's
 *   own "nobody echoed me" retransmission (spec §2.4). Kept rather than hidden: a channel full
 *   of repeats is the thing a person opens this screen to find out.
 * - `snr`, `pathLength`: what the radio reported, when it reported anything.
 */
export const WeatherTrafficEntry = Object.freeze({
  received: 'received',
  sent: 'sent',

  make({
    id,
    at,
    direction = WeatherTrafficEntry.received,
    isBacklog = false,
    channelIndex = null,
    dataType = null,
    botID = null,
    seq = null,
    type = null,
    flags = null,
    length = 0,
    snr = null,
    pathLength = null,
    hex = '',
    isDuplicate = false
  }) {
    return {
      id, at, direction, isBacklog, channelIndex, dataType, botID, seq, type, flags,
      length, snr, pathLength, hex, isDuplicate
    }
  },

  /**
   * An entry for one datagram, with the header read off the bytes where it can be.
   *
   * `decodeHeader` is the four-byte common header only (spec §2.2), never the body: a row is
   * built for a datagram whose *body* the codec refuses, and reading four bytes cannot fail the
   * way reading a truncated polygon can.
   */
  fromDatagram({ id, at, datagram, direction = WeatherTrafficEntry.received, isBacklog = false, isDuplicate = false }) {
    const data = datagram.data ?? new Uint8Array(0)
    let header = null
    if (datagram.dataType === MeshWXWire.dataType && data.length >= MeshWXWire.headerSize) {
      try { header = decodeHeader(data) } catch { header = null }
    }
    return WeatherTrafficEntry.make({
      id,
      at,
      direction,
      isBacklog,
      channelIndex: datagram.channelIndex ?? null,
      dataType: datagram.dataType ?? null,
      botID: header?.bot ?? null,
      seq: header?.seq ?? null,
      type: header?.type ?? null,
      flags: header?.flags ?? null,
      length: data.length,
      snr: datagram.snr ?? null,
      pathLength: datagram.pathLength ?? null,
      hex: bytesToHex(data),
      isDuplicate
    })
  }
})

/**
 * The last `limit` datagrams on the weather channel, kept between visits.
 *
 * A ring, not a history. Three hundred rows is an evening of a busy channel and about 60 kB of
 * hex — enough to answer "what has that bot been sending?" and small enough that it can never
 * become a record of who was on the air when.
 *
 * Persisted through the same injected key-value storage the weather state uses, under its own
 * key: it is a cache of what went past, and like the state it is written best-effort — a blob
 * that cannot be read or written leaves the visit working and nothing kept.
 *
 * `storage` is `{ get(key), set(key, value), delete(key) }`, each async, exactly as
 * `KeyValueWeatherStateStore` takes it. Observers use `subscribe(fn) -> unsubscribe`
 * (PORTING.md §3); `fn` is called with this log after every change.
 */
export class WeatherTrafficLog {
  /** Rows kept, oldest dropped (docs/MESHWX.md "State"). */
  static limit = 300
  /** Its own key beside the weather state's. */
  static key = 'weather.traffic'

  constructor({ storage = null, key = WeatherTrafficLog.key, limit = WeatherTrafficLog.limit } = {}) {
    this.storage = storage
    this.storageKey = key
    this.limit = limit
    this.rows = []
    this.isLoaded = storage == null
    this.listeners = new Set()
    this.writes = Promise.resolve()
    this.isSaveQueued = false
    /** Bumped per row, so two datagrams in the same millisecond still have different ids. */
    this.counter = 0
  }

  /** Reads the persisted rows once. Safe to call again; only the first call reads. */
  async load() {
    if (this.isLoaded || this.storage == null) return this
    this.isLoaded = true
    try {
      const raw = await this.storage.get(this.storageKey)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (Array.isArray(parsed)) this.rows = parsed.slice(-this.limit)
    } catch {
      /* Unreadable: the log starts empty and the next datagram writes a good one. */
    }
    return this
  }

  /** The rows, **oldest first** — the order the timeline reads in, newest at the bottom. */
  entries() {
    return this.rows
  }

  /** The id the next row will carry, so a caller can build an entry itself. */
  nextID(at) {
    this.counter += 1
    return `${at}-${this.counter}`
  }

  /** Appends one row, drops what falls out of the ring, and tells the observers. */
  record(entry) {
    this.rows = [...this.rows, entry]
    if (this.rows.length > this.limit) this.rows = this.rows.slice(-this.limit)
    this.#save()
    this.#yield()
    return entry
  }

  /**
   * Fills in what a row could not know when it was written.
   *
   * There is exactly one such field: `isDuplicate`, which only the reducer can decide and which
   * it decides after the row exists. The row is written first on purpose — a datagram the reducer
   * never reaches (another `data_type`, a body the codec refuses) must still be on the screen.
   */
  update(id, fields) {
    const index = this.rows.findIndex((one) => one.id === id)
    if (index < 0) return null
    const updated = { ...this.rows[index], ...fields }
    this.rows = [...this.rows.slice(0, index), updated, ...this.rows.slice(index + 1)]
    this.#save()
    this.#yield()
    return updated
  }

  /** Empties the log, on the screen's Clear action and on nothing else. */
  clear() {
    this.rows = []
    this.#save()
    this.#yield()
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Waits for the writes in flight; for a test and for a page that is closing. */
  flush() {
    return this.writes
  }

  #yield() {
    for (const fn of [...this.listeners]) fn(this)
  }

  /**
   * One write in flight and at most one waiting. A busy channel would otherwise queue a
   * three-hundred-row write per packet, and every one of them would be superseded before it
   * landed.
   */
  #save() {
    if (this.storage == null || this.isSaveQueued) return
    this.isSaveQueued = true
    this.writes = this.writes.then(async () => {
      this.isSaveQueued = false
      try {
        if (this.rows.length === 0) await this.storage.delete(this.storageKey)
        else await this.storage.set(this.storageKey, this.rows)
      } catch {
        /* A log that cannot be written is still a log for this visit. */
      }
    }, () => { this.isSaveQueued = false })
  }
}
