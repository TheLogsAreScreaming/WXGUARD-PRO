// The radar screen (docs/MESHWX_UI.md §18.2, §18.5), pushed from the place page's Radar card.
//
// One map, framed on the tile, and everything the picture says about the place under it: the
// legend, the time, the summary, and a control that picks the width — Local, Regional, Wide, the
// same three words the traffic log uses, never kilometres (a tile is two degrees, which is 222 km
// tall everywhere and a different width at every latitude).
//
// Two rules the drawing follows and the alert map does not:
//
// - **The alerts are outlines here.** This device may be holding a Flood Warning over the same
//   ground, and a filled polygon over the cells would hide the very thing the screen is for. The
//   shapes go on unfilled, above the cells, so both can be read at once.
// - **Unknown cells are hatched, never left looking dry.** Outside a partial tile's bounds there
//   is no reading at all, and the line under the map says so in words as well.
//
// Revision 13 adds **the last hour**, asked for and never done by itself. Under the map, for
// whatever width is on screen: Play / Pause once the loop has two frames, "Ask for the last hour"
// while it has fewer than five, and a line when a picture is missing. Nothing plays by itself;
// leaving the screen or changing width stops it. Each frame's drawing is built once and the map
// steps through them without re-framing.
//
// It is bound to the page it was opened from (docs/MESHWX_UI.md §3.1 U-18): the place, the tiles
// and the bot all come from that page's snapshot, and never from whichever page the pager has
// since landed on.
import { h } from '../kit/dom.js'
import { Card, List } from '../kit/components.js'
import { cameraBox, cellLayer } from '../kit/MapCanvas.js'
import { t } from '../../l10n.js'
import { MeshWXRadarLevel, MeshWXRadarTile, MeshWXWarning } from '../../meshwx/index.js'
import {
  WeatherRadarAge, WeatherRadarCard, WeatherRadarCells, WeatherRadarLoop, WeatherRadarPicture,
} from '../../screen/index.js'
import { WeatherRequest } from '../../weather/index.js'
import { copy, Line, safeScreen, Segmented } from './support.js'
import { AskButton, AskFootnotes, isAskable, PendingBar } from './WeatherAskControl.js'
import { applyDrawing, MapView, tintOf } from './WeatherAlertMap.js'

/** The three widths the screen offers. Zoom 3 is on the wire and is not one of them (§3). */
export const RADAR_WIDTHS = Object.freeze([0, 1, 2])

/**
 * How long a frame of the loop stays on screen: 0.8 s each, and the newest 2 s, so the loop
 * comes to rest on "now" for long enough to read it before it starts again
 * (docs/MESHWX_UI.md §18.5).
 */
export const RADAR_LOOP_TIMING = Object.freeze({ frameMilliseconds: 800, newestMilliseconds: 2000 })

/** How long frame `index` (0-based, oldest first) of `count` shows before the next. */
export function radarLoopDelay({ index, count }) {
  return index >= count - 1 ? RADAR_LOOP_TIMING.newestMilliseconds : RADAR_LOOP_TIMING.frameMilliseconds
}

/**
 * Everything the screen shows for one width, worked out without the DOM so the rules can be
 * tested: which picture, which square the camera frames, what the asks are, the loop, and which
 * frame is on screen.
 *
 * - `zoom` is the selected segment, one of `RADAR_WIDTHS`.
 * - `frameIndex` is the loop frame on screen (0-based, oldest first), or null for the picture at
 *   rest. Resting on the newest frame is the picture at rest, unless it is playing.
 *
 * `frame` is set while playing, or while paused on an older frame: the time line then reads
 * "6:08 PM · 2 of 5", in the caution tone whenever that frame is old enough to be (from thirty
 * minutes, like any old picture). `summary` always describes the newest picture.
 */
export function radarScreenModel({ place, tiles, zoom, now, frameIndex = null, playing = false }) {
  const width = Math.max(zoom ?? 0, 0)
  const card = WeatherRadarCard.width(width, { place, tiles, now })
  const picture = card.kind === 'held' ? card.picture : null
  const tile = picture?.stored?.tile ?? card.tile ?? WeatherRadarCard.tile({ for: place, zoom: width })
  const at = place?.coordinate ?? null

  const loop = WeatherRadarLoop.make({ tile, tiles, now })
  const loopRequest = at == null
    ? null
    : WeatherRadarLoop.ask(loop, { latitude: at.latitude, longitude: at.longitude, zoom: width })

  const count = loop.frames.length
  let index = frameIndex
  if (index != null && !(index >= 0 && index < count)) index = null
  if (index != null && !playing && index === count - 1) index = null
  const stored = index == null ? null : loop.frames[index]
  const frame = stored == null
    ? null
    : {
      stored,
      number: index + 1,
      count,
      isOld: WeatherRadarAge.make({ takenMinutes: stored.radar.taken_min, now }).isOld,
    }

  return {
    zoom: width,
    card,
    picture,
    summary: picture?.summary ?? null,
    tile,
    request: WeatherRadarCard.ask({ place, zoom: width }),
    loop,
    loopRequest,
    canPlay: WeatherRadarLoop.canPlay(loop),
    canAskForMore: loopRequest != null && !WeatherRadarLoop.isFull(loop),
    frame,
    /** What the map draws: the frame on screen, else the picture at rest. */
    shown: stored ?? picture?.stored ?? null,
  }
}

export function WeatherRadarScreen({ app, page }) {
  const state = { map: null, drawn: null, app }
  // Opened on the width the card was showing, so pushing the card shows the same picture rather
  // than an empty Local square. A tile somebody asked for at zoom 3 is drawn on the card and has
  // no button here, so it opens on the widest that is offered.
  const opened = page?.snapshot?.radar?.picture?.stored?.tile?.zoom ?? 0
  let zoom = Math.min(Math.max(opened, 0), RADAR_WIDTHS[RADAR_WIDTHS.length - 1])
  /** The loop: whether it plays, the frame on screen, and the frames it plays through. */
  const player = { playing: false, index: null, frames: [], timer: null }

  const stop = () => {
    if (player.timer != null) clearTimeout(player.timer)
    player.timer = null
    player.playing = false
    player.index = null
  }

  const schedule = () => {
    if (player.timer != null) clearTimeout(player.timer)
    const count = player.frames.length
    if (!player.playing || count < 2) { stop(); return }
    player.timer = setTimeout(() => {
      player.timer = null
      if (!player.playing) return
      const frames = player.frames.length
      if (frames < 2) { stop(); app.nav.refresh(); return }
      player.index = ((player.index ?? -1) + 1) % frames
      schedule()
      app.nav.refresh()
    }, radarLoopDelay({ index: player.index ?? count - 1, count }))
  }

  const togglePlay = () => {
    if (player.playing) {
      // Paused where it is; paused on the newest reads as the picture at rest.
      player.playing = false
      if (player.timer != null) clearTimeout(player.timer)
      player.timer = null
    } else {
      // From the oldest, or on from the frame it was paused on.
      if (player.index == null) player.index = 0
      player.playing = true
      schedule()
    }
    app.nav.refresh()
  }

  return safeScreen({
    id: 'radar',
    title: () => t('weather.radar.title'),
    // Leaving the screen stops the loop, whether it is popped or something is pushed over it.
    onDisappear: () => stop(),
    render() {
      const words = copy(app, page)
      const snapshot = page?.snapshot ?? null
      const place = snapshot?.place ?? null
      const build = () => radarScreenModel({
        place,
        tiles: snapshot?.radarTiles ?? [],
        zoom,
        now: words.now,
        frameIndex: player.index,
        playing: player.playing,
      })
      let model = build()
      // Frames landing while the loop plays (a loop answer comes oldest first, one packet at a
      // time): the frame on screen stays on screen, wherever it now sits in the list.
      const before = player.index
      const shownTaken = before == null ? null : player.frames[before]?.radar?.taken_min
      player.frames = model.loop.frames
      if (shownTaken != null) {
        const at = player.frames.findIndex((one) => one.radar.taken_min === shownTaken)
        player.index = at >= 0 ? at : null
      }
      if (player.playing && !model.canPlay) stop()
      if (player.index !== before) model = build()

      applyDrawing(state, radarDrawing({ app, snapshot, model }), radarPrint({ app, snapshot, model }))

      const held = model.picture
      const shown = model.shown == null ? null : { stored: model.shown }
      const status = (request) => app.model?.status?.({ for: request })
      // The loop's held list changes under the button as frames land, and with it the `>` line
      // the pending bar matches on: the ask on the air is still this button's.
      const active = app.model?.activeRequest ?? null
      const onScreen = [model.request, model.loopRequest].filter((one) => one != null)
      if (active?.kind === 'radarLoop' && model.loopRequest != null
        && WeatherRequest.coordinateKey(active) === WeatherRequest.coordinateKey(model.loopRequest)
        && (active.zoom ?? 0) === model.loopRequest.zoom) onScreen.push(active)

      return List(
        h('div', { class: 'radar-screen', key: 'map' },
          MapView({ app, state, key: 'radar-map', interactive: true, ariaLabel: t('weather.radar.title') })),

        LoopCard({ app, page, words, model, player, togglePlay, status }),

        Card({ key: 'reading' },
          h('div', { class: 'status-line' },
            held == null
              // Not "no radar picture": this width's square has simply never been asked for, and
              // the button below is the whole of what to do about it.
              ? Line(t('weather.radar.notAsked'))
              : [
                // The newest picture, always: a frame of the loop changes the time, not the words.
                model.summary == null
                  ? null
                  : words.radarSummary(model.summary, page?.placeName ?? '').map((line, index) =>
                    Line(line, { key: `summary-${index}` })),
                // The time carries its own caution from thirty minutes ("· Precipitation has
                // moved since."), so the tone and the sentence are one line and not two. A frame
                // of the loop says its own time and its place in the loop instead.
                model.frame != null
                  ? Line(words.radarFrameLine(model.frame.stored, model.frame.number, model.frame.count),
                    { warn: model.frame.isOld, key: 'time' })
                  : Line(words.radarTime(held), { warn: held.age.isOld, key: 'time' }),
                // Orange, like every other hole in a picture in this tool: grey cells are ground
                // the mosaic never covered, and a reader who takes them for clear weather has
                // been misled by the screen rather than by the radio.
                WeatherRadarPicture.isPartial(shown) ? Line(t('weather.radar.partial'), { warn: true, key: 'partial' }) : null,
                // Quiet: half the detail is still the whole square, and the picture is not wrong
                // — it is what fitting a squall line into one packet costs.
                WeatherRadarPicture.isCoarse(shown) ? Line(t('weather.radar.coarse'), { key: 'coarse' }) : null,
                Line(mosaicLine({ app, words, picture: shown }), { key: 'mosaic' }),
              ])),

        Card({ label: t('weather.areaMap.legend'), key: 'legend' }, Legend()),

        Card({ key: 'width' },
          h('div', { class: 'ask-block' },
            Segmented({
              label: t('weather.radar.width'),
              value: model.zoom,
              options: RADAR_WIDTHS.map((one) => ({ value: one, label: words.radarWidthName(one) })),
              onchange: (next) => { zoom = next; stop(); app.nav.refresh() },
            }),
            // The cost above the button: it is what this tap is about to spend on the shared
            // channel, and a reader who has already tapped does not need telling. Always one
            // packet, at every width, held or not — a radar answer is one packet or a coarser
            // packet, never two (spec §13).
            model.request != null && isAskable(status(model.request)) ? Line(t('weather.areaMap.packetsOne'), { key: 'cost' }) : null,
            model.request != null
              ? AskButton({
                app,
                page,
                title: held == null
                  ? t('weather.radar.ask', page?.sourceName ?? '')
                  : t('weather.radar.askNewer'),
                request: model.request,
                key: 'ask',
              })
              : null,
            AskFootnotes({ app, page }),
            Line(t('weather.radar.ask.footnote'), { key: 'footnote' }))),

        PendingBar({ app, requestsOnScreen: onScreen }))
    },
  })
}

/**
 * The loop row (revision 13): Play / Pause from two frames, the line for a missing picture, and
 * "Ask for the last hour" with its cost above and its note below while there are fewer than five.
 * Nothing at all when there is none of the three to show.
 */
function LoopCard({ app, page, words, model, player, togglePlay, status }) {
  const asks = model.canAskForMore
  if (!model.canPlay && !asks && !model.loop.hasGap) return null
  return Card({ key: 'loop' },
    h('div', { class: 'ask-block' },
      model.canPlay
        ? h('div', { class: 'ask', key: 'play' },
          // The label says what a press does, Play or Pause, so it carries no pressed state too.
          h('button', {
            class: 'button button--plain button--strong ask__button',
            type: 'button',
            onclick: togglePlay,
          }, h('span', null, player.playing ? t('weather.radar.loop.pause') : t('weather.radar.loop.play'))))
        : null,
      model.loop.hasGap ? Line(t('weather.radar.loop.missing'), { warn: true, key: 'gap' }) : null,
      asks && isAskable(status(model.loopRequest))
        ? Line(words.radarLoopCost(WeatherRadarLoop.maxFrames), { key: 'loop-cost' })
        : null,
      asks
        ? AskButton({ app, page, title: t('weather.radar.loop.ask'), request: model.loopRequest, key: 'loop-ask' })
        : null,
      asks ? Line(t('weather.radar.loop.footnote'), { key: 'loop-footnote' }) : null))
}

/**
 * "Cut from the Southern Plains mosaic. · Via GOES satellite" — which of the fourteen pictures
 * this square came out of, and how the radio got it (§12.1). Nothing at all when the bundle does
 * not know the product and the radio did not say where it came from.
 */
function mosaicLine({ app, words, picture }) {
  if (picture?.stored == null) return null
  const parts = [
    words.radarMosaic(picture.stored.radar.product, app?.tables),
    words.dataSource(picture.stored.source),
  ].filter((one) => one != null)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The three swatches, at full strength, in the order the levels run. */
function Legend() {
  const levels = [
    [MeshWXRadarLevel.light, 'light'],
    [MeshWXRadarLevel.moderate, 'moderate'],
    [MeshWXRadarLevel.heavy, 'heavy'],
  ]
  return h('div', { class: 'legend legend--radar', key: 'legend' },
    levels.map(([level, name]) => h('span', {
      class: 'legend__item',
      key: name,
      style: `--tint: var(--radar-${name})`,
    }, h('span', { class: 'legend__swatch' }), h('span', null, t(`weather.radar.level.${name}`)))))
}

/**
 * Each picture's map layer, built the first time it is drawn and kept with the picture: a loop
 * steps through the same five frames over and over, and none of them is rebuilt on a step.
 */
const layers = new WeakMap()

function layerOf(stored) {
  const radar = stored?.radar ?? null
  if (radar == null) return null
  let layer = layers.get(radar)
  if (layer === undefined) {
    layer = cellLayer(WeatherRadarCells.rectangles({ radar }), { unknown: WeatherRadarCells.unknownRectangles({ radar }) })
    layers.set(radar, layer)
  }
  return layer
}

/**
 * What the radar map draws: the cells, the alerts as outlines over them, the place's dot, and the
 * tile as the camera box.
 *
 * The alerts are the ones this device is already holding for the page — nothing is asked for to
 * draw this screen — and they are drawn `fill: false` so the picture underneath survives them.
 *
 * The cells go in as a prebuilt layer (`cellLayer`) outside the fingerprint, so a step of the loop
 * swaps the layer and leaves the camera where the reader put it.
 */
export function radarDrawing({ app, snapshot, model }) {
  const shapes = []
  for (const item of snapshot?.alerts ?? []) {
    const polygon = MeshWXWarning.polygonCoordinates(item.warning)
    if (polygon == null || polygon.length < 3) continue
    shapes.push({
      id: `alert-${item.identity?.event}.${item.identity?.office}.${item.identity?.etn}`,
      rings: [polygon],
      tint: tintOf(item.warning.event, app?.tables),
      fill: false,
      stroke: true,
      lineWidth: 2,
      hitTest: false,
    })
  }
  const tile = model?.tile ?? null
  const place = snapshot?.place ?? null
  return {
    shapes,
    markers: place?.coordinate == null
      ? []
      : [{ latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, kind: 'place' }],
    cellLayer: layerOf(model?.shown),
    // The square the packet is of, whether or not anything has been received for it: a width with
    // nothing held still shows where the tile is.
    bounds: tile == null ? null : cameraBox({
      south: tile.south,
      west: tile.west,
      north: MeshWXRadarTile.north(tile),
      east: MeshWXRadarTile.east(tile),
    }),
    padding: 8,
  }
}

/**
 * What would change the framing or the shapes, and nothing that would not. Never the clock, and
 * never the picture: the cells are a layer of their own, so a new picture or a step of the loop
 * does not move the camera off the square the reader has zoomed into.
 */
export function radarPrint({ app, snapshot, model }) {
  const tile = model?.tile ?? null
  return [
    tile == null ? '' : MeshWXRadarTile.key(tile),
    (snapshot?.alerts ?? []).map((one) => `${one.identity?.event}.${one.identity?.office}.${one.identity?.etn}`).join(','),
    snapshot?.place?.coordinate?.latitude,
    snapshot?.place?.coordinate?.longitude,
    app?.basemap != null,
  ].join('|')
}
