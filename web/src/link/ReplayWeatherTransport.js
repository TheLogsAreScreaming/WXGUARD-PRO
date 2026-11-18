// A `WeatherTransport` that replays recorded datagrams: the demo mode, and the way to look at the
// tool with no radio and no bridge. The recording (`demo/datagrams.json`) is what WX-AUS really
// transmitted on #meshwx; every time inside it is moved forward by the same amount so the newest
// datagram reads as "just now", otherwise every reading would arrive already stale.
//
// Requests go nowhere: there is nobody to ask. `sendChannelRequest` resolves (the radio "took"
// it) and no answer ever comes, which is what an out-of-range bot looks like.
import { decode, encode, hexToBytes } from '../meshwx/index.js'
import { WeatherBot, WeatherChannel } from '../weather/index.js'

const MESHWX_DATA_TYPE = 0xff10

/**
 * Moves every absolute time in a decoded message by `minutes`. Relative fields are left alone.
 *
 * `taken_min` is in here with the rest: a radar picture's own time is what every line about it is
 * measured from, and a tile replayed with the time it really carried would read as hours old on
 * a recording that is otherwise minutes old (spec §13, revision 11). A warning's start
 * (`begins_min`, revision 12) moves with its issue time and expiry, so a watch recorded before it
 * began is replayed as one that has not begun.
 */
export function shiftTimes(message, minutes) {
  const shifted = structuredClone(message)
  const move = (object, key) => { if (Number.isInteger(object?.[key])) object[key] += minutes }
  for (const key of ['expires_min', 'issued_min', 'begins_min', 'now_min', 'ts_min', 'built_min', 'taken_min']) {
    move(shifted, key)
  }
  for (const entry of shifted.entries ?? []) move(entry, 'expires_min')
  return shifted
}

export class ReplayWeatherTransport {
  static channelIndex = 1

  /**
   * @param {object} options
   * @param {{ bot: { name: string, bot_id: number }, datagrams: { ts: number, data_type: number, hex: string, resend?: boolean }[] }} options.recording
   * @param {() => number} [options.now] milliseconds
   * @param {number} [options.spacingMs] gap between replayed datagrams
   */
  constructor({ recording, now = () => Date.now(), spacingMs = 15 }) {
    this.recording = recording
    this.now = now
    this.spacingMs = spacingMs
    this.datagramListeners = new Set()
    this.started = false
  }

  subscribeDatagrams(fn) {
    this.datagramListeners.add(fn)
    if (!this.started) { this.started = true; this.#replay() }
    return () => this.datagramListeners.delete(fn)
  }

  subscribeAcknowledgements() { return () => {} }
  async resetPath() {}
  async sendRequest() { return new Uint8Array(4) }
  async sendChannelRequest() {}
  async channelSecret({ at }) { return at === ReplayWeatherTransport.channelIndex ? WeatherChannel.secret() : null }
  async isDrainingBacklog() { return false }

  async linkState() {
    const { name, bot_id: botID } = this.recording.bot ?? {}
    if (!name || !Number.isInteger(botID)) return null
    // Only the first two bytes of a key matter to the tool: they are the bot id (spec §2.2).
    const publicKey = new Uint8Array(32)
    publicKey[0] = botID & 0xff
    publicKey[1] = (botID >> 8) & 0xff
    return { kind: 'up', bot: WeatherBot.make({ publicKey, name, latitude: 0, longitude: 0, lastAdvert: null }) }
  }

  async #replay() {
    const items = (this.recording.datagrams ?? []).filter((d) => !d.resend)
    if (!items.length) return
    const newest = Math.max(...items.map((d) => d.ts))
    const shiftMinutes = Math.floor((this.now() / 1000 - newest) / 60)
    for (const item of items) {
      let data = hexToBytes(item.hex)
      if (item.data_type === MESHWX_DATA_TYPE) {
        try { data = encode(shiftTimes(decode(data), shiftMinutes)) } catch { /* replay it as recorded */ }
      }
      const datagram = { channelIndex: ReplayWeatherTransport.channelIndex, pathLength: 0xff, dataType: item.data_type, data, snr: 6.5 }
      for (const fn of this.datagramListeners) fn(datagram)
      if (this.spacingMs) await new Promise((resolve) => setTimeout(resolve, this.spacingMs))
    }
  }
}
