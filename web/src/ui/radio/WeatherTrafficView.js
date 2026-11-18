// The channel traffic screen (docs/MESHWX_UI.md §17), pushed from the `#meshwx` card on the radio
// page.
//
// Owner, 20 September 2026: *"A way to see all the GRP_DATA traffic on a channel like we do a
// chat."* So it reads as a chat and not as a table: what came in is a bubble on the left under the
// radio's name, what this phone sent is a bubble on the right, oldest at the top, and it opens
// scrolled to the newest.
//
// It is the **traffic**, not this app's opinion of it. A duplicate, somebody else's request and a
// datagram the codec refuses are all here, each labelled as what it is: the screen exists so a
// person can answer "what has that bot been sending?" without reading a console log over somebody
// else's shoulder.
//
// Nothing here goes on the air. The only write it makes is Clear, on the phone's own log.
import { h } from '../kit/dom.js'
import { Button, Card, List, Prose, Row } from '../kit/components.js'
import { t } from '../../l10n.js'
import { decode, hexToBytes, MeshWXTypeNames, MeshWXWire } from '../../meshwx/index.js'
import { WeatherTrafficEntry } from '../../weather/index.js'
import { copy, Line, safeScreen } from './support.js'

/** How near the bottom counts as "still following the newest", in CSS pixels. */
const PINNED_SLACK = 56

/**
 * `WeatherTrafficScreen({ app, page })`.
 *
 * `page` is only for the clock and the bot names: the log is the device's, not a page's, but the
 * times on it are formatted against the page the screen was opened from, as every other pushed
 * screen's are (§3.1 P-1).
 */
export function WeatherTrafficScreen({ app, page }) {
  // Screen-local: whether the reader is still following the newest. Scrolling up stops the
  // timeline jumping under a finger, which is the one thing a chat must never do.
  const state = { host: null, isPinned: true }

  const entries = () => app.model?.trafficEntries?.() ?? []

  const stickToBottom = () => {
    const host = state.host
    if (host == null || !state.isPinned) return
    if (typeof requestAnimationFrame !== 'function') { host.scrollTop = host.scrollHeight; return }
    requestAnimationFrame(() => { if (state.isPinned && state.host != null) state.host.scrollTop = state.host.scrollHeight })
  }

  /**
   * The Clear action, behind a confirmation: the log is the only record of what went past, and a
   * mis-tap on a bar button should not be able to end it.
   */
  const confirmClear = () => {
    const count = entries().length
    app.nav.sheet({
      title: () => t('weather.traffic.clearTitle'),
      done: t('weather.common.cancel'),
      render: (handle) => List(
        Card({}, Prose(t('weather.traffic.clearMessage', count))),
        h('div', { class: 'sheet__actions' }, Button({
          label: t('weather.traffic.clear'),
          kind: 'destructive',
          block: true,
          onclick: () => {
            handle.close()
            app.model?.clearTraffic?.()
            state.isPinned = true
            app.nav.refresh()
          },
        }))),
    })
  }

  return safeScreen({
    id: 'traffic',
    title: () => t('weather.traffic.title'),
    trailing: () => (entries().length === 0
      ? null
      : Button({ label: t('weather.traffic.clear'), kind: 'plain', onclick: confirmClear })),
    render() {
      const words = copy(app, page)
      const rows = entries()
      stickToBottom()

      return h('div', { class: 'timeline-host' },
        h('p', { class: 'list__note timeline__note' }, t('weather.traffic.subtitle')),
        h('div', {
          class: 'timeline',
          key: 'timeline',
          hook: (element) => {
            const host = element.closest('.screen')
            if (host == null) return null
            state.host = host
            const onScroll = () => {
              const distance = host.scrollHeight - host.scrollTop - host.clientHeight
              state.isPinned = distance < PINNED_SLACK
            }
            host.addEventListener('scroll', onScroll, { passive: true })
            // Opened scrolled to the newest, after the bubbles have been laid out.
            state.isPinned = true
            stickToBottom()
            return () => { host.removeEventListener('scroll', onScroll); state.host = null }
          },
        },
        rows.length === 0
          ? h('p', { class: 'timeline__empty' }, t('weather.traffic.empty'))
          : bubbles({ app, page, rows, words })))
    },
  })
}

/** The rows as bubbles, with a name above each run from one sender. */
function bubbles({ app, page, rows, words }) {
  const out = []
  let lastSender = null
  rows.forEach((row, index) => {
    const sender = senderKey(row.entry)
    if (sender !== lastSender) {
      lastSender = sender
      out.push(h('p', {
        class: ['timeline__who', row.entry.direction === WeatherTrafficEntry.sent && 'timeline__who--mine'],
        key: `who-${row.entry.id}`,
      }, senderName(app, row.entry)))
    }
    out.push(Bubble({ app, page, row, words, key: row.entry.id ?? `row-${index}` }))
  })
  return out
}

function senderKey(entry) {
  if (entry.direction === WeatherTrafficEntry.sent) return 'sent'
  return `bot:${entry.botID ?? 'unknown'}`
}

function senderName(app, entry) {
  if (entry.direction === WeatherTrafficEntry.sent) return t('weather.traffic.you')
  if (entry.botID == null) return t('weather.traffic.unknownSender')
  return app.model?.botName?.(entry.botID) ?? String(entry.botID)
}

/**
 * One datagram: what kind of message it is, what this one carries, and the header facts the radio
 * reported. A tap opens the fields and the bytes.
 */
function Bubble({ app, page, row, words, key }) {
  const { entry, summary } = row
  const isMine = entry.direction === WeatherTrafficEntry.sent
  const notes = [
    entry.isBacklog ? t('weather.traffic.backlog') : null,
    entry.isDuplicate ? t('weather.traffic.duplicate') : null,
  ].filter(Boolean)

  return h('button', {
    class: ['bubble', isMine && 'bubble--mine'],
    type: 'button',
    key,
    onclick: () => app.nav.push(WeatherTrafficDetailScreen({ app, page, row })),
  },
  h('span', { class: 'bubble__title' }, summary.title),
  summary.detail ? h('span', { class: 'bubble__detail' }, summary.detail) : null,
  h('span', { class: 'bubble__facts' }, facts(entry, words)),
  notes.length > 0 ? h('span', { class: 'bubble__notes' }, notes.join(' · ')) : null)
}

/** "159 B · seq 212 · SNR 12 dB · 2 hops · 13:35" — what is known, and nothing that is not. */
export function facts(entry, words) {
  return [
    t('weather.traffic.bytes', entry.length ?? 0),
    entry.seq == null ? null : t('weather.traffic.seq', entry.seq),
    entry.snr == null ? null : t('weather.traffic.snr', signalToNoise(entry.snr)),
    hops(entry),
    words.time(entry.at),
  ].filter(Boolean).join(' · ')
}

/** A whole number where the radio reported one, one decimal where it did not. */
function signalToNoise(snr) {
  return Number.isInteger(snr) ? String(snr) : Number(snr).toFixed(1)
}

/**
 * How far it travelled. `0xFF` is the firmware's flood sentinel, not 255 hops (spec §11), and a
 * flooded datagram is what every request and every broadcast answer is.
 *
 * The rest of the byte is not a count either: bits 7-6 are the hash-size mode and bits 5-0 the
 * hops (`decodePathLen`), so a two-byte-hash single hop is 0x41 and reads as "1 hop". Nought
 * hops says nothing at all — an absent line reads as "straight from the radio", which is what it
 * is, and "0 hops" reads as a fact somebody has to stop and parse.
 */
function hops(entry) {
  const path = entry.pathLength
  if (path == null) return null
  if (path === 0xff) return t('weather.traffic.flood')
  const count = path & 63
  if (count === 0) return null
  return count === 1 ? t('weather.traffic.hopsOne') : t('weather.traffic.hops', count)
}

// MARK: - One datagram, in full

/**
 * What a bubble opens: the header the radio reported, the message as the codec read it, and the
 * bytes themselves.
 *
 * The fields are the decoded message's own (`decode`), which is the vector's snake_case shape and
 * not a Swift name (docs/PORTING.md §5): this screen is looking at the wire, so it says what the
 * wire says. A datagram the codec cannot read says so and still shows its bytes — that is the one
 * it was most worth being able to open.
 */
export function WeatherTrafficDetailScreen({ app, page, row }) {
  const { entry, summary } = row

  return safeScreen({
    id: 'traffic-detail',
    title: () => summary.title,
    render() {
      const words = copy(app, page)
      let message = null
      if (entry.dataType === MeshWXWire.dataType) {
        try { message = decode(hexToBytes(entry.hex)) } catch { message = null }
      }

      return List(
        Card({ label: t('weather.traffic.about'), key: 'about' },
          Row({ title: t('weather.traffic.field.when'), value: words.time(entry.at), chevron: false }),
          Row({
            title: t('weather.traffic.field.from'),
            // A row has space for the whole sentence; the timeline's header over a run of
            // bubbles wants a name, and uses the short one.
            value: entry.direction === WeatherTrafficEntry.sent
              ? t('weather.traffic.sent')
              : senderName(app, entry),
            chevron: false,
          }),
          Row({ title: t('weather.traffic.field.size'), value: t('weather.traffic.bytes', entry.length ?? 0), chevron: false }),
          entry.seq == null ? null : Row({ title: t('weather.traffic.field.seq'), value: String(entry.seq), chevron: false }),
          entry.snr == null ? null : Row({ title: t('weather.traffic.field.signal'), value: t('weather.traffic.snr', signalToNoise(entry.snr)), chevron: false }),
          hops(entry) == null ? null : Row({ title: t('weather.traffic.field.hops'), value: hops(entry), chevron: false }),
          entry.channelIndex == null ? null : Row({ title: t('weather.traffic.field.slot'), value: String(entry.channelIndex), chevron: false }),
          entry.type == null
            ? null
            : Row({ title: t('weather.traffic.field.type'), value: MeshWXTypeNames[entry.type] ?? String(entry.type), chevron: false }),
          entry.dataType == null
            ? null
            : Row({
              title: t('weather.traffic.field.dataType'),
              value: h('span', { class: 'mono' }, `0x${entry.dataType.toString(16).toUpperCase().padStart(4, '0')}`),
              chevron: false,
            }),
          entry.isBacklog ? Line(t('weather.traffic.backlog')) : null,
          entry.isDuplicate ? Line(t('weather.traffic.duplicate')) : null),

        Card({ label: t('weather.traffic.fields'), key: 'fields' },
          message == null
            ? Line(t('weather.traffic.notDecoded'), { warn: true })
            : h('div', { class: 'fields' }, fieldRows(message))),

        Card({ label: t('weather.traffic.hex'), key: 'hex' },
          h('pre', { class: 'hexdump' }, entry.hex ?? '')),
      )
    },
  })
}

/**
 * A decoded message as rows. Nested values are indented rather than flattened or `[object
 * Object]`: a sweep's entries and a warning's area runs are the interesting part of those
 * messages, and a row that said "areas: 12 items" would be hiding exactly what was asked for.
 */
export function fieldRows(value, { depth = 0 } = {}) {
  const out = []
  for (const [name, field] of Object.entries(value ?? {})) {
    if (field == null) { out.push(fieldLine(name, '', depth)); continue }
    if (Array.isArray(field)) {
      if (field.length === 0) { out.push(fieldLine(name, '', depth)); continue }
      if (field.every(isScalar)) { out.push(fieldLine(name, field.map(scalarText).join(', '), depth)); continue }
      out.push(fieldHeading(name, depth))
      field.forEach((one, index) => {
        out.push(fieldHeading(String(index), depth + 1))
        out.push(...fieldRows(one, { depth: depth + 2 }))
      })
      continue
    }
    if (typeof field === 'object') {
      out.push(fieldHeading(name, depth))
      out.push(...fieldRows(field, { depth: depth + 1 }))
      continue
    }
    out.push(fieldLine(name, scalarText(field), depth))
  }
  return out
}

function isScalar(value) {
  return value == null || typeof value !== 'object'
}

function scalarText(value) {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function fieldLine(name, text, depth) {
  return h('div', { class: 'field', style: `--depth: ${depth}` },
    h('span', { class: 'field__name mono' }, name),
    h('span', { class: 'field__value mono' }, text))
}

function fieldHeading(name, depth) {
  return h('div', { class: 'field field--heading', style: `--depth: ${depth}` },
    h('span', { class: 'field__name mono' }, name))
}
