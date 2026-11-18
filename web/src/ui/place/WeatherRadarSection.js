// The Radar section of a place page (docs/MESHWX_UI.md §18.1), under the forecast.
//
// Three states and no fourth, which is `WeatherRadarCard`'s own shape:
//
//   *nothing held*  "No radar picture yet." and the ask
//   *held*          a square, still map of the tile, the summary, the time, and the ask again
//   *no coordinate* no section at all — not an empty one, absent
//
// The whole picture is one button that opens the radar screen. A card whose only content is a
// map looks tappable and does nothing unless the button itself has the hit area
// (docs/MESHWX_UI.md §3.1 U-32), so the map inside takes no gestures of its own: `interactive:
// false`, and the tile is framed rather than freely pannable.
//
// **This is the one ask on a place page.** Everything else there is Update's (§11.1), and radar
// is not Update's: a picture is one packet, it is never asked for on a schedule
// (docs/MESHWX_UI.md §18), and a tile nobody asked for is a tile the channel never carried.
import { h } from '../kit/dom.js'
import { icon } from '../kit/icons.js'
import { Card } from '../kit/components.js'
import { cameraBox, MapCanvas } from '../kit/MapCanvas.js'
import { t } from '../../l10n.js'
import { MeshWXPlaceNames, MeshWXRadarTile } from '../../meshwx/index.js'
import { WeatherRadarCard, WeatherRadarCells, WeatherRadarPicture } from '../../screen/index.js'
import { WeatherAskButton, WeatherAskFootnotes } from './WeatherAskControl.js'
import {
  attempt, nowOf, pageIDOf, placeNameOf, radarSummary, radarTime, radarWidthName, sourceNameOf,
} from './support.js'

/**
 * The canvas of one page, kept across re-renders.
 *
 * A `data-static` element is built once and left alone by `morph`, so the map is pushed new cells
 * from `render()` rather than rebuilt with them (docs/UI_KIT.md). The place page is a plain
 * function called on every model change and has no closure of its own to hold this in, so it is
 * held per page id here and dropped when the element leaves the document.
 */
const maps = new Map()

function stateFor(pageID) {
  let state = maps.get(pageID)
  if (state == null) maps.set(pageID, (state = { map: null, drawn: null, latest: null }))
  return state
}

/** The card, as a Node, or null for a place with no coordinate. */
export function WeatherRadarSection({ app, screen, onOpen }) {
  const card = screen?.snapshot?.radar ?? null
  if (card == null || card.kind === 'noCoordinate') return null

  const tile = card.kind === 'held' ? card.picture.stored.tile : card.tile
  const request = attempt(() => WeatherRadarCard.ask({ place: screen?.snapshot?.place ?? null }))
  if (request == null) return null

  const held = card.kind === 'held' ? card.picture : null
  return Card({
    label: t('weather.radar.title'),
    // The width, quietly, and only when it is not the one this card's ask would fetch: a tile
    // somebody else asked for at another width is a picture of a bigger square than the button
    // below offers, and the card says which rather than letting the reader assume.
    labelTrailing: held?.isWiderThanAsked ? radarWidthName(tile.zoom) : null,
    key: 'radar',
  },
  held != null
    ? picture({ app, screen, picture: held, tile, onOpen })
    : h('p', { class: 'card__note' }, t('weather.radar.empty')),
  h('div', { class: 'ask-block' },
    // Always one packet, whatever is held and whatever the width: a radar answer is one packet
    // or a coarser packet, never two (spec §13). Said before the tap and not after it.
    isAskable(screen, request) ? h('p', { class: 'footnote' }, t('weather.areaMap.packetsOne')) : null,
    WeatherAskButton({
      app,
      screen,
      // "Ask WX-AUS for the radar picture" the first time, and "Ask for a newer picture" once
      // there is one on screen: the second is not a repeat of the first, and the bot is named
      // in the line above it either way.
      title: held != null ? t('weather.radar.askNewer') : t('weather.radar.ask', sourceNameOf(screen)),
      request,
    }),
    // The standard note sits directly under the button and the radar one last, the order the
    // phone's ask control gives (`showsFootnotes` puts its own notes first).
    WeatherAskFootnotes({ app, screen }),
    h('p', { class: 'footnote' }, t('weather.radar.ask.footnote'))))
}

/** Whether a tap would put something on the air, so the cost is said to somebody who can spend it. */
function isAskable(screen, request) {
  const kind = attempt(() => (screen?.model ?? null)?.status?.({ for: request })?.kind)
  return kind == null || kind === 'idle' || kind === 'settled'
}

/** The map, the sentences and the time, all inside the button that opens the radar screen. */
function picture({ app, screen, picture: held, tile, onOpen }) {
  const now = nowOf(screen, app)
  // One sentence, as the phone's card has it: the summary is two or three short statements about
  // one picture, and a paragraph each would make a card of them.
  const summary = (attempt(() => radarSummary(held.summary, { placeName: placeNameOf(screen) })) ?? []).join(' ')
  const time = attempt(() => radarTime(held, { now, timeZone: app?.timeZone, locale: app?.locale }))

  return h('button', {
    class: 'card-map radar-card',
    type: 'button',
    key: 'picture',
    onclick: () => onOpen?.(),
    'aria-label': [t('weather.radar.title'), summary, time].filter(Boolean).join('. '),
  },
    MapElement({ app, screen, picture: held, tile }),
    h('div', { class: 'radar-card__body' },
      summary ? h('p', { class: 'radar-card__line' }, summary) : null,
      // The time takes the caution tone from thirty minutes and says why in the same line: the
      // picture is still drawn, because where the storm was half an hour ago beats no picture.
      h('p', { class: ['footnote', held.age.isOld && 'footnote--warn'] }, time ?? ''),
      WeatherRadarPicture.isPartial(held) ? h('p', { class: 'footnote' }, t('weather.radar.partial')) : null),
    h('span', { class: 'card-map__open' },
      h('span', null, t('weather.areaMap.open')),
      h('span', { class: 'row__chevron' }, icon('chevron.right', { size: 14 }))))
}

/** The square still of the tile. Built once; the cells are pushed into it on every render. */
function MapElement({ app, screen, picture: held, tile }) {
  const pageID = pageIDOf(screen) ?? 'page'
  const state = stateFor(pageID)
  const place = screen?.snapshot?.place ?? null
  state.latest = { app, held, tile, place }
  // Everything that would change the picture, and nothing that would not: the clock is not in it,
  // because re-shading a thousand cells every thirty seconds is not free.
  const print = [
    MeshWXRadarTile.key(tile), held.stored.radar.taken_min, held.stored.radar.coarse,
    (held.stored.radar.bounds ?? []).join(','), place?.coordinate?.latitude, place?.coordinate?.longitude,
    app?.basemap != null,
  ].join('|')
  paint(state, print)

  return h('div', {
    class: 'map map--card map--radar',
    key: 'radar-map',
    'data-static': '',
    // The button around it names itself, so the picture inside is decoration to a screen reader.
    'aria-hidden': 'true',
    hook: (element) => {
      state.map = new MapCanvas(element, { interactive: false, labels: true })
      state.drawn = null
      paint(state, print)
      return () => {
        state.map?.destroy()
        maps.delete(pageID)
      }
    },
  })
}

function paint(state, print) {
  const map = state.map
  if (map == null || state.latest == null) return
  const { app, held, tile, place } = state.latest
  // The basemap and the place names are fetched at boot and can arrive after the first render.
  if (app?.basemap != null) map.setBasemap(app.basemap)
  if (app?.tables?.places != null) {
    map.setPlaces(app.tables.places, { nameOf: (one) => MeshWXPlaceNames.placeName(one.name) })
  }
  if (state.drawn === print) return
  state.drawn = print
  const radar = held.stored.radar
  map.setCells(WeatherRadarCells.rectangles({ radar }), {
    unknown: WeatherRadarCells.unknownRectangles({ radar }),
  })
  map.setMarkers(place?.coordinate == null
    ? []
    : [{ latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, kind: 'place' }])
  // The tile and nothing but the tile: a square of the earth in a square on the page, so what is
  // drawn is exactly what the packet carried.
  map.fit(cameraBox({
    south: tile.south,
    west: tile.west,
    north: MeshWXRadarTile.north(tile),
    east: MeshWXRadarTile.east(tile),
  }), { padding: 0, maxZoom: 13 })
}
