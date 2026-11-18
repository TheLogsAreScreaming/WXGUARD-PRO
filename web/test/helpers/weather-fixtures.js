// Port of MC1ServicesTests/Weather/WeatherTestSupport.swift (docs/PORTING.md).
//
// The Austin bot of the kit's vectors, message builders, a fake radio the service can be driven
// through, and a clock that is also the scheduler.
//
// Every message here is a **decoded wire object** built by hand, exactly the `decoded` JSON of
// `docs/meshwx_v5_vectors.json` (PORTING.md §5), so these suites never wait on the codec.

import { WeatherBot } from '../../src/weather/WeatherBot.js'
import { WeatherChannel } from '../../src/weather/WeatherChannel.js'
import { WeatherTransportError } from '../../src/weather/WeatherService.js'

/** `bot = 19578` (0x4C7A) in every kit vector: a public key starting `7A 4C`. */
export const botID = 19578
export const botPublicKey = Uint8Array.from([0x7a, 0x4c, ...new Array(30).fill(0x11)])
export const bot = WeatherBot.make({
  publicKey: botPublicKey, name: 'WX-AUS', latitude: 30.27, longitude: -97.74, lastAdvert: null
})

/** 2026-09-15 00:45 UTC, in milliseconds, and its Unix minutes. */
export const t0 = 1_789_436_700 * 1000
export const t0Minutes = Math.floor(1_789_436_700 / 60)

export const svw42 = { event: 3, office: 35, etn: 42 }
export const svw43 = { event: 3, office: 35, etn: 43 }
export const wsw7 = { event: 24, office: 35, etn: 7 }

/** Where the weather came from, in its place in the flags nibble (spec §2.2, bits 3-2). */
function sourceBits(source) {
  return source << 2
}

function header({ seq, type, name, flags = 0, bot: from = botID }) {
  return { seq, bot: from, type, name, flags }
}

/**
 * `issuedMinutes` puts the warning into the revision 5 form (spec §3): flags nibble bit 1 and
 * the issue time, which the wire carries as the gap back from `expires_min` and the decoder
 * resolves to the absolute minute. `beginsMinutes` is the revision 12 start, resolved the same
 * way; it has no flag bit.
 */
export function warning({
  seq,
  identity = svw42,
  expiresMinutes = t0Minutes + 45,
  isUpdate = false,
  windMph = 60,
  issuedMinutes = null,
  beginsMinutes = null,
  source = 0,
  polygon = [[30.52, -97.98], [30.61, -97.62], [30.38, -97.41]],
  areas = [{ state: 42, county: true, start: 453, run: 1 }],
  bot: from = botID
} = {}) {
  // Flags nibble: bit 0 update, bit 1 the issue time follows, bits 3-2 where the data came from.
  const flags = (isUpdate ? 1 : 0) | (issuedMinutes == null ? 0 : 2) | sourceBits(source)
  return {
    ...header({ seq, type: 1, name: 'warning', flags, bot: from }),
    event: identity.event,
    office: identity.office,
    etn: identity.etn,
    expires_min: expiresMinutes,
    tornado: 2,
    flood_source: 0,
    flood_damage: 0,
    hail_qin: 4,
    wind_mph: windMph,
    update: isUpdate,
    source,
    polygon,
    areas,
    issued_min: issuedMinutes,
    begins_min: beginsMinutes
  }
}

export function cancel({ seq, identity = svw42, reason = 1, bot: from = botID } = {}) {
  return {
    ...header({ seq, type: 2, name: 'cancel', flags: reason & 0x0f, bot: from }),
    event: identity.event,
    office: identity.office,
    etn: identity.etn,
    reason
  }
}

/** `entries` is `[[identity, expiresRelativeMinutes], …]`. */
export function digest({
  seq, nowMinutes = t0Minutes, feedHealth = 7, entries = [], source = 0, bot: from = botID
} = {}) {
  return {
    ...header({ seq, type: 3, name: 'digest', flags: sourceBits(source), bot: from }),
    now_min: nowMinutes,
    feed_health: feedHealth,
    entries: entries.map(([identity, relative]) => ({
      event: identity.event,
      office: identity.office,
      etn: identity.etn,
      expires_rel: relative,
      expires_min: nowMinutes + relative
    })),
    source
  }
}

/**
 * `ages` puts the batch into the revision 5 form (spec §6.1): flags nibble bit 0 and one age
 * per station, in minutes behind `ts_min`. All or nothing, so it must name every station in the
 * batch or none of them. `stations` is `[[index, tempF], …]`.
 */
export function observations({
  seq, timestampMinutes = t0Minutes, stations = [], ages = null, source = 0, bot: from = botID
} = {}) {
  return {
    ...header({
      seq, type: 4, name: 'observations', flags: (ages == null ? 0 : 1) | sourceBits(source), bot: from
    }),
    ts_min: timestampMinutes,
    stations: stations.map(([station, tempF], position) => ({
      station,
      temp_f: tempF,
      dewpoint_f: null,
      wind_dir_deg: 0,
      wind_dir: 'N',
      sky: 1,
      wind_mph: 0,
      gust_mph: 0,
      visibility_mi: null,
      pressure_inhg: null,
      humidity_pct: null,
      feels_delta_f: 0,
      age_min: ages == null ? null : ages[position]
    })),
    source
  }
}

export function forecast({
  seq, point = 102, issuedMinutes = t0Minutes, source = 0, bot: from = botID
} = {}) {
  return {
    ...header({ seq, type: 5, name: 'forecast', flags: sourceBits(source), bot: from }),
    point,
    issued_min: issuedMinutes,
    first_period: 1,
    periods: [
      {
        high_f: null, low_f: 73, pop_pct: 20, sky: 2, thunder: false, wintry: false,
        windy: false, fog: false, wind_dir_deg: 157.5, wind_dir: 'SSE', wind_mph: 5
      },
      {
        high_f: 93, low_f: null, pop_pct: 40, sky: 3, thunder: true, wintry: false,
        windy: false, fog: false, wind_dir_deg: 180, wind_dir: 'S', wind_mph: 10
      }
    ],
    source
  }
}

/**
 * `wasCut` puts the chunk into the revision 7 form (spec §8): flags nibble bit 0, which the
 * bot sets on every chunk of a reply whose tail it had to drop.
 */
export function text({
  seq, subject = 0, group, index, total, text: body, wasCut = false, source = 0, bot: from = botID
}) {
  return {
    ...header({
      seq, type: 6, name: 'text', flags: (wasCut ? 1 : 0) | sourceBits(source), bot: from
    }),
    subject,
    group,
    idx: index,
    total,
    text: body,
    cut: wasCut,
    source
  }
}

/**
 * One packet of an area sweep (spec §12).
 *
 * `scope` is revision 10's: the state indices packet 0 names. Passing any makes the packet a
 * scoped one; a packet past 0 of a scoped sweep is `{ isScoped: true }` with no scope, which is
 * exactly what the wire carries.
 */
export function areaSweep({
  seq,
  builtMinutes = t0Minutes,
  group,
  index,
  total,
  entries,
  wasCut = false,
  includesAdvisories = false,
  scope = [],
  isScoped = scope.length > 0,
  source = 0,
  bot: from = botID
}) {
  return {
    ...header({
      seq,
      type: 10,
      name: 'area_sweep',
      flags: (wasCut ? 1 : 0) | (includesAdvisories ? 2 : 0) | sourceBits(source),
      bot: from
    }),
    built_min: builtMinutes,
    group,
    idx: index,
    total,
    entries,
    cut: wasCut,
    advisories: includesAdvisories,
    scoped: isScoped,
    scope,
    source
  }
}

/** Texas zones 192-197 under a Severe Thunderstorm Warning. */
export const texasSweepEntry = Object.freeze({ event: 3, state: 42, county: false, start: 192, run: 6 })
/** Oklahoma counties 1-4 under a Winter Storm Warning. */
export const oklahomaSweepEntry = Object.freeze({ event: 24, state: 35, county: true, start: 1, run: 4 })

/**
 * WX-AUS's real statement (spec §10, the vector `coverage_wx_aus`): 120 km around Austin, the
 * offices EWX/FWD/HGX/SJT, and its 36 zones as five runs, neither list cut.
 */
export const austinCoverage = Object.freeze({
  lat: 30.2672,
  lon: -97.7431,
  radius_km: 120,
  stations: 14,
  offices: [35, 40, 51, 113],
  areas: [
    { state: 42, county: false, start: 155, run: 6 },
    { state: 42, county: false, start: 170, run: 6 },
    { state: 42, county: false, start: 186, run: 12 },
    { state: 42, county: false, start: 205, run: 7 },
    { state: 42, county: false, start: 221, run: 5 }
  ],
  zones_cut: false,
  offices_cut: false
})

export function coverage({ seq, coverage: body = austinCoverage, bot: from = botID } = {}) {
  // Flags nibble: bit 0 the zones were cut, bit 1 the offices were (spec §10).
  const flags = (body.zones_cut ? 1 : 0) | (body.offices_cut ? 2 : 0)
  return { ...header({ seq, type: 8, name: 'coverage', flags, bot: from }), ...body }
}

/**
 * A grid for a radar tile: `size` rows of `size` dry cells, with `cells` (`[row, col, level]`)
 * set. North row first, west column first, as the decoded message carries them (spec §13).
 */
export function radarRows({ size = 32, cells = [] } = {}) {
  const grid = Array.from({ length: size }, () => new Array(size).fill(0))
  for (const [row, col, level] of cells) grid[row][col] = level
  return grid.map((row) => row.join(''))
}

/**
 * One radar tile (type 11, spec §13, revision 11).
 *
 * `bounds` is the four-element wire array and makes the packet partial; a 16-row grid makes it
 * coarse. Both are read off the body rather than passed as flags, exactly as the codec does.
 */
export function radar({
  seq,
  takenMinutes = t0Minutes,
  south = 29,
  west = -99,
  zoom = 0,
  product = 1,
  rows = radarRows(),
  bounds = null,
  source = 1,
  bot: from = botID
} = {}) {
  const size = rows.length
  const isCoarse = size === 16
  const flags = (isCoarse ? 1 : 0) | (bounds == null ? 0 : 2) | sourceBits(source)
  return {
    ...header({ seq, type: 11, name: 'radar', flags, bot: from }),
    taken_min: takenMinutes,
    south,
    west,
    zoom,
    product,
    coarse: isCoarse,
    partial: bounds != null,
    bounds,
    size,
    rows,
    source
  }
}

export function notAvailable({ seq, letter, reason, bot: from = botID }) {
  return {
    ...header({ seq, type: 7, name: 'not_available', bot: from }),
    request: letter,
    request_code: letter.charCodeAt(0),
    reason
  }
}

/**
 * Another phone's `>` request, flooded on the channel (spec §11). Not this phone's: the sender
 * prefix and the seq are somebody else's, which is the whole point of the fixture.
 */
export function request({
  seq = 7, bot: from = botID, sender = '0a0b0c0d0e0f', at = t0, text: body = '>d'
} = {}) {
  return {
    ...header({ seq, type: 9, name: 'request', bot: from }),
    sender,
    ts: Math.floor(at / 1000),
    text: body
  }
}

/** This phone's own 32-byte key, whose first six bytes a Request datagram carries. */
export const phonePublicKey = Uint8Array.from([1, 2, 3, 4, 5, 6, ...new Array(26).fill(0x77)])

/** Wraps a message in the datagram the firmware would deliver. */
export function datagram(message, { dataType = 0xff10, channelIndex = 3 } = {}) {
  return { channelIndex, pathLength: 0xff, dataType, data: message, snr: 6.5 }
}

/**
 * A decoder for the fake radio: the fixtures put the decoded message straight into the
 * datagram's `data`, so "decoding" is handing it back. Bytes that are not one — the truncated
 * datagram of `undecodable bytes are dropped` — throw, as the codec does.
 */
export function fixtureDecode(data) {
  if (data == null || typeof data !== 'object' || typeof data.name !== 'string') {
    throw new Error('not a MeshWX message')
  }
  return data
}

/**
 * A radio the tests control: datagrams and delivery confirmations are pushed in, DMs are
 * recorded with the ACK code the radio would expect back.
 */
export class FakeWeatherTransport {
  /**
   * @param channelRequestsSupported whether this radio can flood a Request datagram. False is
   *   the old firmware, or a radio with no `#meshwx` slot: `sendChannelRequest` then refuses and
   *   the service falls back to the DM ladder.
   */
  constructor({ channelRequestsSupported = true } = {}) {
    this.channelRequestsSupported = channelRequestsSupported
    this.sent = []
    /** The Request datagrams the service flooded on `#meshwx`, in order (spec §11). */
    this.channelSent = []
    /** The routes the service asked the radio to forget, in order: one per flood attempt. */
    this.resets = []
    this.failNextSend = false
    this.confirmsDuringSend = false
    this.secrets = new Map()
    this.secretLookups = []
    this.drainingBacklog = false
    this.link = null
    /** How often a channel request was refused because this radio cannot send one. */
    this.channelRequestsRefused = 0
    this.datagramListeners = new Set()
    this.acknowledgementListeners = new Set()
  }

  /**
   * A deterministic stand-in for the firmware's ACK derivation over a fixed sender key: each
   * transmission has its own code, which is all the service reads.
   */
  static ackCode({ text, timestamp, attempt }) {
    let hash = 0x811c9dc5
    for (const character of `${text}|${timestamp}|${attempt}`) {
      hash ^= character.charCodeAt(0)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return Uint8Array.from([hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff])
  }

  async isDrainingBacklog() { return this.drainingBacklog }

  setDrainingBacklog(draining) { this.drainingBacklog = draining }

  async resetPath({ to }) { this.resets.push(to) }

  async linkState() { return this.link }

  setLink(link) { this.link = link }

  async channelSecret({ at }) {
    this.secretLookups.push(at)
    return this.secrets.has(at) ? this.secrets.get(at) : null
  }

  setSecret(secret, at) { this.secrets.set(at, secret) }

  subscribeDatagrams(fn) {
    this.datagramListeners.add(fn)
    return () => this.datagramListeners.delete(fn)
  }

  subscribeAcknowledgements(fn) {
    this.acknowledgementListeners.add(fn)
    return () => this.acknowledgementListeners.delete(fn)
  }

  async sendRequest({ to, text: body, timestamp, attempt }) {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('deviceError(1)')
    }
    const ackCode = FakeWeatherTransport.ackCode({ text: body, timestamp, attempt })
    this.sent.push({ publicKey: to, text: body, timestamp, attempt, ackCode })
    if (this.confirmsDuringSend) {
      this.acknowledge(ackCode)
      // Long enough for the service to take the confirmation before this send returns.
      await new Promise((resolve) => setImmediate(resolve))
    }
    return ackCode
  }

  async sendChannelRequest({ text: body, botID: to, timestamp, seq }) {
    if (!this.channelRequestsSupported) {
      this.channelRequestsRefused += 1
      throw WeatherTransportError.channelRequestsUnavailable('the fake radio has no #meshwx slot')
    }
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('deviceError(1)')
    }
    this.channelSent.push({ text: body, botID: to, timestamp, seq })
  }

  setChannelRequestsSupported(supported) { this.channelRequestsSupported = supported }

  /** Pushes a delivery confirmation, as the radio's ACK push. */
  acknowledge(code) {
    for (const listener of [...this.acknowledgementListeners]) listener(code)
  }

  setConfirmsDuringSend(confirms) { this.confirmsDuringSend = confirms }

  deliver(item) {
    for (const listener of [...this.datagramListeners]) listener(item)
  }

  setFailNextSend(fail) { this.failNextSend = fail }
}

/** A fake radio whose slot 3 — where fixture datagrams arrive — carries `#meshwx`. */
export async function makeTransport(options = {}) {
  const transport = new FakeWeatherTransport(options)
  transport.setSecret(await WeatherChannel.secret(), 3)
  return transport
}

/**
 * A settable clock that is also the service's scheduler, so a fifteen-second timeout is one
 * `await clock.advance(15)` instead of a real wait.
 */
export class WeatherTestClock {
  constructor(start = t0) {
    this.now = start
    this.timers = new Map()
    this.nextID = 1
  }

  setTimeout(fn, milliseconds) {
    const id = this.nextID
    this.nextID += 1
    this.timers.set(id, { at: this.now + milliseconds, fn })
    return id
  }

  clearTimeout(id) { this.timers.delete(id) }

  /** Moves the clock forward, firing every timer that falls due and everything it re-arms. */
  async advance(seconds) {
    const target = this.now + seconds * 1000
    for (;;) {
      let due = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (due == null || timer.at < due.timer.at)) due = { id, timer }
      }
      if (due == null) break
      this.timers.delete(due.id)
      this.now = Math.max(this.now, due.timer.at)
      await due.timer.fn()
      await flush()
    }
    this.now = target
    await flush()
  }
}

/** Drains the microtask queue, so everything the service chained has run. */
export async function flush(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Collects the events a service emits, for the assertions the Swift makes on its stream. */
export function collectEvents(service) {
  const events = []
  service.subscribe((event) => events.push(event))
  return events
}

/** The `requestSettled` events, as `[request, outcome]` pairs. */
export function settlements(events) {
  return events
    .filter((event) => event.kind === 'requestSettled')
    .map((event) => [event.value, event.value2])
}
