// Port of MC1/Views/Tools/Weather/WeatherAlertMap.swift: what a weather map draws, and the map
// itself.
//
// The iOS tool draws on MapLibre over downloaded tiles. This client is used where there is no
// internet at all, so the base layer is `MapCanvas` — the state outlines in `assets/basemap.json`
// and the bundle's own place names — and a "drawing" is the list of shapes, markers and the box
// to frame them in. The rules above it are the Swift's, unchanged: the warning's own polygon when
// it has one, the outlines of the areas it names otherwise, one colour per event from
// `MeshWXPresentation.tint`, and the most severe drawn last so it sits on top.
import { h } from '../kit/dom.js'
import { icon } from '../kit/icons.js'
import { MapCanvas } from '../kit/MapCanvas.js'
import { t } from '../../l10n.js'
import { MeshWXAreaSweep, MeshWXPlaceNames, MeshWXPresentation, MeshWXWarning } from '../../meshwx/index.js'
import { safeScreen } from './support.js'
import { PendingOverlay } from './WeatherAskControl.js'

// MARK: - Drawings

const EMPTY = Object.freeze({ shapes: [], markers: [], bounds: null })

/** A growing latitude/longitude box, padded the way the Swift `bounds(_:)` pads. */
function box() {
  return { minLatitude: Infinity, maxLatitude: -Infinity, minLongitude: Infinity, maxLongitude: -Infinity, any: false }
}

function widen(target, coordinate) {
  if (coordinate == null) return
  const { latitude, longitude } = coordinate
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
  target.any = true
  if (latitude < target.minLatitude) target.minLatitude = latitude
  if (latitude > target.maxLatitude) target.maxLatitude = latitude
  // West of the date line is laid out west of Hawaii, as the map itself does it (`MapCanvas`).
  const westward = longitude > 0 ? longitude - 360 : longitude
  if (westward < target.minLongitude) target.minLongitude = westward
  if (westward > target.maxLongitude) target.maxLongitude = westward
}

function widenRings(target, rings) {
  for (const ring of rings) for (const coordinate of ring) widen(target, coordinate)
}

function padded(target) {
  if (!target.any) return null
  const latitudePad = Math.max((target.maxLatitude - target.minLatitude) * 0.2, 0.05)
  const longitudePad = Math.max((target.maxLongitude - target.minLongitude) * 0.2, 0.05)
  return {
    minLatitude: Math.max(-90, target.minLatitude - latitudePad),
    maxLatitude: Math.min(90, target.maxLatitude + latitudePad),
    minLongitude: target.minLongitude - longitudePad,
    maxLongitude: Math.min(0, target.maxLongitude + longitudePad),
  }
}

/** The event's colour, from the VTEC code the bundle gives its event byte. */
export function tintOf(event, tables) {
  return MeshWXPresentation.tint({ forVTEC: tables?.vtec?.({ for: event }) ?? '' })
}

/**
 * Everything a warning map draws: `{ shapes, markers, bounds }`.
 *
 * - A storm-based product's own polygon, filled and stroked in the event's tint.
 * - The outlines of the areas it names — filled when it has no polygon, and, when it does, as a
 *   **dashed outline under** it, so a reader can see the counties the product was issued for as
 *   well as the shape the forecaster drew.
 * - An area the bundle has no outline for becomes a marker at its centre rather than vanishing.
 * - The place is one neutral dot, never a warning-coloured pin (docs/MESHWX_UI.md §3.1 U-17).
 *
 * `framesPlace` puts the place in the camera box; off, the box is the alerts' own, so an alert
 * two states away is not drawn at country scale just because the place is on the map.
 */
export const WeatherMapDrawing = Object.freeze({
  empty: EMPTY,

  make({ warnings, place, framesPlace = true, tables, geometry }) {
    const shapes = []
    const markers = []
    const framed = box()
    let index = 0

    for (const warning of warnings ?? []) {
      const tint = tintOf(warning.event, tables)
      const polygon = MeshWXWarning.polygonCoordinates(warning)
      const areas = tables?.namedAreas?.({ for: warning }) ?? []
      const unique = uniqueByUGC(areas)
      const outline = []
      for (const area of unique) {
        const rings = geometry?.rings?.({ for: area.ugc }) ?? null
        const usable = (rings ?? []).filter((ring) => ring.length >= 3)
        if (usable.length > 0) {
          outline.push(...usable)
        } else if (area.lat != null && area.lon != null) {
          markers.push({ latitude: area.lat, longitude: area.lon, kind: 'station', label: area.name ?? area.ugc })
          widen(framed, { latitude: area.lat, longitude: area.lon })
        }
      }

      if (polygon != null && polygon.length >= 3) {
        // The named areas go down first, dashed and unfilled, so the polygon reads as the shape
        // that matters and the counties as the ground it was issued over.
        if (outline.length > 0) {
          shapes.push({ id: `areas-${index}`, rings: outline, tint, fill: false, stroke: true, dashed: true, hitTest: false })
        }
        shapes.push({ id: `polygon-${index}`, rings: [polygon], tint, fill: true, stroke: true })
        widenRings(framed, [polygon])
      } else if (outline.length > 0) {
        shapes.push({ id: `areas-${index}`, rings: outline, tint, fill: true, stroke: true })
        widenRings(framed, outline)
      }
      index += 1
    }

    if (place?.coordinate != null) {
      markers.push({ latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, kind: 'place' })
      if (framesPlace || !framed.any) widen(framed, place.coordinate)
    }

    return { shapes, markers, bounds: padded(framed) }
  },
})

/** One area of a national sweep, deduplicated: the first entry naming it is the most severe. */
function uniqueByUGC(areas) {
  const seen = new Set()
  const out = []
  for (const area of areas ?? []) {
    const key = String(area.ugc ?? '').toUpperCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(area)
  }
  return out
}

/**
 * What the alert map draws (docs/MESHWX_UI.md §17):
 * `{ shapes, markers, bounds, legend, areaCount, undrawnCount }`.
 *
 * The same lookup an alert's own map does — `MeshWXGeometry.rings` for the outline,
 * `MeshWXPresentation.tint` for the colour — so the two maps cannot drift apart.
 *
 * **Areas are deduplicated, first entry wins.** Entries arrive most severe first (spec §12), so a
 * county under both a Tornado Warning and a Flood Advisory is red, once. The shapes are handed
 * over in reverse, so the most severe is drawn **last** and a tap on overlapping shading resolves
 * to it: `MapCanvas.shapesAt` answers topmost first.
 *
 * A sweep can name hundreds of areas, so this runs once per sweep and never per render.
 */
export const WeatherAreaMapDrawing = Object.freeze({
  empty: Object.freeze({ ...EMPTY, legend: [], areaCount: 0, undrawnCount: 0 }),

  make({ entries, tables, geometry }) {
    const shapes = []
    const legend = []
    const seenAreas = new Set()
    const seenEvents = new Set()
    const framed = box()
    let areaCount = 0
    let undrawnCount = 0
    const states = tables?.states ?? []

    for (const entry of entries ?? []) {
      const tint = tintOf(entry.event, tables)
      let drewAny = false
      const codes = MeshWXAreaSweep.Entry.ugcCodes(entry, { states })
      for (const ugc of codes) {
        const key = String(ugc).toUpperCase()
        if (seenAreas.has(key)) continue
        seenAreas.add(key)
        areaCount += 1
        const rings = (geometry?.rings?.({ for: ugc }) ?? []).filter((ring) => ring.length >= 3)
        if (rings.length === 0) {
          // The bundle is a cut in time and the UGC tables grow: counted and said out loud
          // rather than swallowed, so nobody reads a missing shape as clear weather.
          undrawnCount += 1
          continue
        }
        // `part` is the index of the picture part this entry came from (`WeatherAlertMapPicture`),
        // so a tap on the shading opens a screen that can say when *that* part was built rather
        // than when the newest one was. Absent for a drawing built from one sweep's entries.
        shapes.push({ id: key, rings, tint, fill: true, stroke: true, data: { ugc: key, event: entry.event, part: entry.part ?? 0 } })
        widenRings(framed, rings)
        drewAny = true
      }
      if (drewAny && !seenEvents.has(entry.event)) {
        seenEvents.add(entry.event)
        legend.push({ event: entry.event, tint })
      }
    }

    return {
      // Reversed: most severe last, so it is on top and wins a tap.
      shapes: shapes.reverse(),
      markers: [],
      bounds: padded(framed),
      // The picture frames the country, not the box around Guam and Maine.
      frame: 'national',
      legend,
      areaCount,
      undrawnCount,
    }
  },
})

// MARK: - The map itself

/** One shared preload of the 14 MB of outlines, so two screens asking for them do it once. */
let preloading = null

export function preloadGeometry(app) {
  if (app?.geometry?.preload == null) return Promise.resolve()
  if (isGeometryLoaded(app)) return Promise.resolve()
  preloading ??= Promise.resolve(app.geometry.preload()).catch(() => {}).finally(() => { preloading = null })
  return preloading
}

export function isGeometryLoaded(app) {
  const geometry = app?.geometry
  if (geometry == null) return false
  return geometry.isZoneFileLoaded === true && geometry.isCountyFileLoaded === true
}

/**
 * The canvas itself. `data-static` plus a `hook`, so a re-render never rebuilds it and never
 * throws away what it has drawn (docs/UI_KIT.md); the drawing is pushed in from `render()`
 * through `applyDrawing`, behind a fingerprint.
 *
 * `state` is the screen's own closure object; the map lands on `state.map`.
 */
export function MapView({ app, state, key = 'map', interactive = true, card = false, ariaLabel = null, onTap = null }) {
  state.app = app
  return h('div', {
    class: ['map', card && 'map--card'],
    key,
    'data-static': '',
    // An interactive map is keyboard-reachable (the canvas takes focus), so it is always named.
    // A still inside a button that names itself is decoration and is hidden instead.
    role: ariaLabel != null ? 'img' : null,
    'aria-label': ariaLabel,
    'aria-hidden': ariaLabel == null ? 'true' : null,
    hook: (element) => {
      const map = new MapCanvas(element, { interactive, labels: true })
      state.map = map
      state.drawn = null
      if (onTap) map.onTap = onTap
      // `render()` runs before the hook does, so the first drawing is waiting here.
      if (state.latest != null) paint(state, state.latest.drawing, state.latest.print)
      return () => {
        map.destroy()
        state.map = null
        state.drawn = null
      }
    },
  })
}

/**
 * Push a drawing into a mounted map, once per change. `print` is the caller's fingerprint: the
 * things that would change the picture, and never the clock — an unchanged set of alerts is not
 * re-shaded every 30 seconds, and re-shading a country is not cheap.
 *
 * Safe to call before the canvas exists: the drawing is kept and painted when the hook runs.
 */
export function applyDrawing(state, drawing, print) {
  if (state == null || drawing == null) return
  state.latest = { drawing, print }
  paint(state, drawing, print)
}

/**
 * The same, but the drawing is only **built** when the fingerprint changes: a warning map walks
 * every named area and every outline, and a render that would draw the same picture should do no
 * work at all. Returns the drawing on screen.
 */
export function drawWhenChanged(state, print, build) {
  if (state?.latest?.print === print) {
    paint(state, state.latest.drawing, print)
    return state.latest.drawing
  }
  const drawing = build()
  applyDrawing(state, drawing, print)
  return drawing
}

function paint(state, drawing, print) {
  const map = state.map
  if (map == null) return
  // The basemap and the place names are fetched at boot and can arrive after the first render.
  if (state.app?.basemap != null) map.setBasemap(state.app.basemap)
  if (state.app?.tables?.places != null) {
    map.setPlaces(state.app.tables.places, { nameOf: (place) => MeshWXPlaceNames.placeName(place.name) })
  }
  // A radar layer built ahead (`cellLayer`), outside the fingerprint: the radar screen's loop
  // steps through one per frame, and a step must neither rebuild nor re-frame anything
  // (revision 13). Only a drawing that carries the key is touched by it.
  if (drawing.cellLayer !== undefined) map.setCellLayer(drawing.cellLayer)
  if (state.drawn === print) return
  state.drawn = print
  map.setShapes(drawing.shapes ?? [])
  map.setMarkers(drawing.markers ?? [])
  // The radar layer, when the drawing has one: under the shapes and over the basemap's fill, so
  // an alert outline and the cells under it can both be read (docs/MESHWX_UI.md §18.2).
  if (drawing.cells != null || drawing.unknownCells != null) {
    map.setCells(drawing.cells ?? [], { unknown: drawing.unknownCells ?? [] })
  }
  map.fit(drawing.frame ?? drawing.bounds ?? 'conus', {
    padding: drawing.padding ?? (drawing.frame ? 12 : 28),
  })
}

/**
 * The still map at the top of a list, and the line that says it opens.
 *
 * A card whose only content is a picture looks tappable and does nothing unless the button itself
 * has a hit area (docs/MESHWX_UI.md §3.1 U-32), so the whole card is one real button and the map
 * inside it takes no gestures of its own.
 */
export function MapCard({ app, state, onOpen, label, key = 'map-card' }) {
  return h('button', { class: 'card card-map', type: 'button', key, onclick: onOpen, 'aria-label': label },
    MapView({ app, state, key: 'map', interactive: false, card: true, ariaLabel: null }),
    h('span', { class: 'card-map__open' },
      h('span', null, t('weather.areaMap.open')),
      h('span', { class: 'row__chevron' }, icon('chevron.right', { size: 14 }))))
}

/**
 * What would change a warning map's picture, and nothing that would not: the alerts by identity
 * and expiry (an update moves the expiry and can move the shape), the place, and whether the
 * outlines have loaded. Never the clock.
 */
export function alertsPrint(app, items, place, framesPlace) {
  return [
    items.map((item) => `${item.identity?.event}.${item.identity?.office}.${item.identity?.etn}:${item.warning?.expires_min}`).join(','),
    place == null ? '' : `${place.label}@${place.coordinate?.latitude},${place.coordinate?.longitude}`,
    framesPlace,
    isGeometryLoaded(app),
  ].join('|')
}

/**
 * The full, interactive map the alerts list's header and the alert detail's card open.
 *
 * `items` is a function so the map stays live: an update or a cancel that arrives while the map
 * is open is drawn, because the screen reads the page's build on every refresh rather than
 * holding a copy of it (§13). `framesPlace` is the alert detail's rule — an alert elsewhere
 * frames itself, not the country between it and you.
 */
export function WeatherAlertFullMapScreen({ app, page, title, items = null, framesPlace = true }) {
  const state = { map: null, drawn: null, app }
  const alertsOf = items ?? (() => page?.snapshot?.alerts ?? [])

  return safeScreen({
    id: 'alerts-map',
    fullBleed: true,
    title: () => title ?? t('weather.alertsList.title', page?.sourceName ?? ''),
    render() {
      const snapshot = page?.snapshot ?? null
      const alerts = alertsOf() ?? []
      drawWhenChanged(state, alertsPrint(app, alerts, snapshot?.place ?? null, framesPlace), () => WeatherMapDrawing.make({
        warnings: alerts.map((item) => item.warning),
        place: snapshot?.place ?? null,
        framesPlace,
        tables: app.tables,
        geometry: app.geometry,
      }))
      return h('div', { class: 'map-screen' },
        MapView({ app, state, key: 'map', interactive: true, ariaLabel: t('weather.alertsList.openMap') }),
        PendingOverlay({ app, requestsOnScreen: [] }))
    },
  })
}
