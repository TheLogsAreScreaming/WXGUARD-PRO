// The weather service's transport over a real radio: the port of Swift
// `SessionWeatherTransport` (MC1Services/Services/Weather/WeatherService.swift) and of
// `WeatherChannel.swift`.
//
// `src/weather` never imports `src/radio`: the service talks to a duck-typed
// `WeatherTransport` and this is the radio's implementation of it (docs/PORTING.md §9).
// Swift's `AsyncStream` accessors become `subscribe*(fn) → unsubscribe`.

import { MeshWXEncoder } from '../meshwx/index.js'
import { WeatherChannel, WeatherTransportError, hashSecret } from '../weather/index.js'

// The channel, the error and the key derivation belong to the weather layer, as in the Swift.
// They are re-exported so this file stays the one import a radio host needs.
export { WeatherChannel, WeatherTransportError, hashSecret }

/**
 * Channel slots searched for `#meshwx` when a request is about to go out: the companion
 * firmware's `MAX_GROUP_CHANNELS`, 40.
 *
 * The first cut scanned 0-7 and the owner's radio keeps `#meshwx` in slot 31, so every
 * request went out as a DM with "no slot on this radio carries #meshwx" in the log
 * (17 September). A radio with fewer slots answers an error past its last one, which reads
 * as "not here" and moves on.
 */
export const CHANNEL_SLOTS = 40

// MARK: - The v5 Request datagram (type 9, spec §11)

/** MeshCore `data_type` carrying a v5 message (development range, spec §2.1). */
export const MESHWX_DATA_TYPE = 0xff10
/**
 * Bytes of the sender's public key a Request carries: the same six-byte prefix a DM
 * identifies the phone by, so one phone's DM and its datagram are one sender (spec §11).
 */
export const REQUEST_SENDER_PREFIX_SIZE = 6
/** UTF-8 bytes a Request's text may take (spec §11). */
export const MAX_REQUEST_TEXT_BYTES = 40

/**
 * The Request datagram's bytes, header and all (spec §11):
 *
 *   `[seq:1][bot u16 LE:2][(type << 4) | flags = 0x90 :1][sender:6][ts u32 LE:4][text ≤ 40]`
 *
 * The codec's own encoder; `request_digest` in `docs/meshwx_v5_vectors.json` is the check.
 *
 * @param {object} args
 * @param {number} args.seq the sender's counter, repeated on a resend
 * @param {number} args.botID the bot asked; `0xFFFF` asks them all
 * @param {Uint8Array} args.senderPrefix the first six bytes of this radio's public key
 * @param {number} args.timestamp Unix **seconds** (not milliseconds); a resend repeats it
 * @param {string} args.text the §14 request, starting with `>`
 */
export function encodeRequestDatagram({ seq, botID, senderPrefix, timestamp, text }) {
  if (senderPrefix.length !== REQUEST_SENDER_PREFIX_SIZE) {
    throw new RangeError(
      `request sender prefix must be ${REQUEST_SENDER_PREFIX_SIZE} bytes, got ${senderPrefix.length}`,
    )
  }
  return MeshWXEncoder.request({ seq: seq & 0xff, bot: botID & 0xffff, senderPrefix, timestamp: timestamp >>> 0, text })
}

// MARK: - The transport

/**
 * The production weather transport over a `MeshCoreSession`.
 *
 * What the weather service needs from a radio: channel datagrams in both directions, a DM
 * going out, and a way to tell which slot is `#meshwx`. Narrow on purpose, so tests can
 * drive the service with a fake and so requests provably never touch the chat path.
 */
export class SessionWeatherTransport {
  #session
  #storedChannelSecret
  #drainingBacklog
  #channelDataSupported
  #storedWeatherSlot
  /**
   * The slot proven to carry `#meshwx`, once one has been found. Only positive answers are
   * kept: a slot is what the user just wrote the channel into, so "not there" must not stick.
   */
  #weatherSlot = null

  /**
   * @param {object} args
   * @param {object} args.session a `MeshCoreSession` from `src/radio`
   * @param {(index: number) => Promise<Uint8Array|null>} [args.storedChannelSecret] the app's
   *   own channel table, consulted when the radio cannot be asked.
   * @param {() => Promise<boolean>} [args.isDrainingBacklog] whether the firmware queue is
   *   being drained. The default reads the session's own flag, so everything the session
   *   pulled at connect reads as backlog and everything else as live.
   * @param {() => Promise<boolean>} [args.supportsChannelData] whether this radio can *send*
   *   a channel datagram (`CMD_SEND_CHANNEL_DATA`, 0x3E, firmware v11+). Defaults to the
   *   session's `supportsChannelDatagrams`, the same gate the screen reads.
   * @param {() => Promise<number|null>} [args.storedWeatherSlot] the slot the app's channel
   *   table holds `#meshwx` in, asked before any slot is scanned. The default knows nothing
   *   and leaves it to the scan.
   */
  constructor({
    session,
    storedChannelSecret = async () => null,
    isDrainingBacklog = null,
    supportsChannelData = null,
    storedWeatherSlot = async () => null,
  }) {
    this.#session = session
    this.#storedChannelSecret = storedChannelSecret
    this.#drainingBacklog = isDrainingBacklog ?? (async () => session.isDrainingBacklog)
    this.#channelDataSupported = supportsChannelData ?? (async () => session.supportsChannelDatagrams)
    this.#storedWeatherSlot = storedWeatherSlot
  }

  /**
   * Every channel datagram the radio delivers, as a `MeshCore.ChannelDatagram`
   * (`{ channelIndex, pathLength, dataType, data, snr }`). Every other event is ignored.
   */
  subscribeDatagrams(fn) {
    return this.#session.subscribe((event) => {
      if (event.kind === 'channelDataReceived') fn(event.value)
    })
  }

  /**
   * The codes of the radio's delivery confirmations (the ACK push) as they arrive: each says
   * the recipient's radio received a DM this radio sent.
   */
  subscribeAcknowledgements(fn) {
    return this.#session.subscribe((event) => {
      if (event.kind === 'acknowledgement') fn(event.code)
    })
  }

  /**
   * Sends a plain-text DM with `timestamp` and `attempt` on the wire as given, and returns
   * the ACK code the radio expects back for this transmission. A resend passes the first
   * send's timestamp with the next attempt: the same message to the bot's radio, under a new
   * code.
   */
  async sendRequest({ to, text, timestamp, attempt }) {
    const info = await this.#session.sendMessage({ to, text, timestamp, attempt })
    return info.expectedAck
  }

  /**
   * The request as a datagram on the `#meshwx` slot, flooded (spec §11): every repeater in
   * reach forwards it once, and no stored route can lose it — which is the whole reason the
   * datagram replaced the DM.
   *
   * Three things have to be true and each is a different "no": the firmware has the command,
   * some slot on this radio carries the channel, and the radio has told the app its own
   * public key — the six bytes the bot pairs this client's datagrams and DMs by. Any of them
   * missing is `channelRequestsUnavailable`, and the service sends the DM instead.
   *
   * Nothing comes back from the air. A datagram has no acknowledgement — the answer on the
   * channel is the acknowledgement — so a send that returns says only that the radio took it.
   *
   * What it *does* return is the datagram itself, which is the one thing only this side knows:
   * the service logs what this device put on the channel beside what it heard (docs/MESHWX_UI.md
   * §17), and the bytes, the slot and this radio's own key prefix are all made here. A transport
   * that returns nothing is not an error — the service encodes the Request the text stands for
   * instead — so the shape stays optional for the bridge and the replay transports.
   *
   * @param {object} args
   * @param {string} args.text the `>` request (spec §14)
   * @param {number} args.botID the bot asked, the first two bytes of its public key
   * @param {number} args.timestamp milliseconds; the request's own time, repeated byte for
   *   byte on the one resend
   * @param {number} args.seq the **sender's** counter, likewise repeated on the resend
   * @returns {Promise<{ channelIndex: number, dataType: number, data: Uint8Array }>} the
   *   datagram as it went out
   */
  async sendChannelRequest({ text, botID, timestamp, seq }) {
    if (!(await this.#channelDataSupported())) {
      throw WeatherTransportError.channelRequestsUnavailable(
        "the radio's firmware is older than v1.15.0 and has no send-channel-data command",
      )
    }
    const slot = await this.#meshWXSlot()
    if (slot == null) {
      throw WeatherTransportError.channelRequestsUnavailable(
        'no slot on this radio carries #meshwx',
      )
    }
    const key = this.#session.selfInfo?.publicKey
    if (key == null || key.length < REQUEST_SENDER_PREFIX_SIZE) {
      throw WeatherTransportError.channelRequestsUnavailable(
        'the radio has not reported its own public key',
      )
    }

    const payload = encodeRequestDatagram({
      seq,
      botID,
      senderPrefix: key.slice(0, REQUEST_SENDER_PREFIX_SIZE),
      timestamp: Math.floor(timestamp / 1000),
      text,
    })

    await this.#session.sendChannelData({
      channelIndex: slot,
      dataType: MESHWX_DATA_TYPE,
      payload,
      pathLength: 0xff, // flood
      pathBytes: new Uint8Array(0),
    })
    return { channelIndex: slot, dataType: MESHWX_DATA_TYPE, data: payload }
  }

  /**
   * Forgets the route the radio holds to a public key, so the next DM to it goes out by
   * flood rather than hop by hop along a route that may be stale. The chat rule
   * (docs/guides/Messaging.md, D5), applied to a weather request after its on-route sends
   * have gone unanswered and unconfirmed.
   */
  async resetPath({ to }) {
    await this.#session.resetPath({ publicKey: to })
  }

  /**
   * The 16-byte secret of a channel slot, or `null` when it cannot be read.
   *
   * The app's table first — no radio round trip while the firmware queue is draining — then
   * the radio on a miss: weather monitoring starts before the connect-time channel sync, so
   * a fresh table can lack a slot the radio has.
   */
  async channelSecret({ at }) {
    const weatherSecret = await WeatherChannel.secret()
    const stored = await this.#storedChannelSecret(at)
    if (stored != null && equalBytes(stored, weatherSecret)) return stored
    try {
      const info = await this.#session.getChannel({ index: at })
      if (info != null) return info.secret
    } catch {
      // A slot past the radio's last one answers an error, which reads as "not here".
    }
    return (await this.#storedChannelSecret(at)) ?? null
  }

  /**
   * Whether the radio's message queue — what it held while the browser was away — is being
   * drained right now. A datagram delivered meanwhile is backlog: it can be hours old, and
   * it says nothing about whether the bot is in range now.
   */
  async isDrainingBacklog() {
    return this.#drainingBacklog()
  }

  /**
   * The link this transport provides of its own. Over a radio there is none: whether weather
   * can be asked for follows the radio, which is the app's business and not the transport's.
   */
  async linkState() {
    return null
  }

  /** The slot carrying `#meshwx`, by secret, cached for the session once found. */
  async #meshWXSlot() {
    if (this.#weatherSlot != null) return this.#weatherSlot
    // The table first: it is what the radio said at the last sync, and it knows slot 31
    // without thirty-one round trips.
    const stored = await this.#storedWeatherSlot()
    if (stored != null) {
      this.#weatherSlot = stored
      return stored
    }
    const found = await findWeatherSlot(this.#session)
    if (found != null) this.#weatherSlot = found
    return found
  }
}

// MARK: - Slot helpers

/**
 * The slot on this radio carrying `#meshwx`, or `null`.
 *
 * By secret: the secret is what decrypts the channel, so a slot holding it *is* `#meshwx`
 * whatever it was named when it was added (another app, a typed variant). Slots are read one
 * at a time up to `CHANNEL_SLOTS`; a radio with fewer answers an error past its last one,
 * which reads as "not here" and moves on.
 */
export async function findWeatherSlot(session) {
  const weatherSecret = await WeatherChannel.secret()
  for (let index = 0; index < CHANNEL_SLOTS; index += 1) {
    let info = null
    try {
      info = await session.getChannel({ index })
    } catch {
      continue
    }
    if (info != null && equalBytes(info.secret, weatherSecret)) return index
  }
  return null
}

/**
 * Writes `#meshwx` into the first free slot above 0 (slot 0 is the public channel) and
 * returns that index, or returns the slot that already carries it.
 *
 * **Only ever call this from a user tap.** Adding a channel changes the radio's
 * configuration; docs/MESHWX.md is explicit that the app prompts and never does it silently.
 *
 * The chosen slot is read back from the radio immediately before the write, and a slot the
 * radio says is taken is refused rather than overwritten — the same order `WeatherToolModel
 * .addChannel()` follows, because the app's own table can be stale and someone else's
 * channel is not ours to replace.
 *
 * @returns {Promise<{ index: number, added: boolean }>} `added` is false when the channel was
 *   already there.
 * @throws {WeatherTransportError} `kind: 'channelRequestsUnavailable'` when every slot is
 *   taken or the radio reports fewer than two.
 */
export async function addWeatherChannel(session) {
  const existing = await findWeatherSlot(session)
  if (existing != null) return { index: existing, added: false }

  const maxChannels = Math.min(session.deviceInfo?.maxChannels ?? 0, CHANNEL_SLOTS)
  if (maxChannels <= 1) {
    throw WeatherTransportError.channelRequestsUnavailable(
      'this radio reports fewer than two channel slots',
    )
  }

  const secret = await WeatherChannel.secret()
  for (let index = 1; index < maxChannels; index += 1) {
    // Re-read the slot from the radio right before writing it.
    let info = null
    try {
      info = await session.getChannel({ index })
    } catch {
      continue
    }
    if (isSlotConfigured(info)) continue
    await session.setChannel({ index, name: WeatherChannel.name, secret })
    return { index, added: true }
  }

  throw WeatherTransportError.channelRequestsUnavailable('every channel slot on this radio is taken')
}

/**
 * A slot counts as taken when it has a name or a non-zero secret — the rule
 * `ChannelService.isChannelConfigured` applies. A slot with an empty name but a real secret
 * is configured: something is using it, whatever it forgot to call itself.
 */
function isSlotConfigured(info) {
  if (info == null) return false
  if (info.name.length > 0) return true
  return info.secret.some((byte) => byte !== 0)
}

function equalBytes(a, b) {
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
