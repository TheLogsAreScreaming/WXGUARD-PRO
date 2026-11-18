// An offline map on a canvas. No tiles and no network: the base layer is the state outlines in
// `assets/basemap.json` (built from the bundle's own county file), the labels are the bundle's
// places, and everything drawn over them comes from the outlines the app already carries. It is
// the web counterpart of the iOS tool's MapLibre views, for a client that is used where there is
// no internet at all.
//
//   const map = new MapCanvas(container, { interactive: true })
//   map.setBasemap(basemapJSON)                       // once, shared
//   map.setPlaces(tables.places)                      // optional city labels
//   map.setShapes([{ id, rings, tint, fill, stroke, dashed, data }])
//   map.setCells(rectangles, { unknown })            // radar levels, in degrees
//   map.setCellLayer(cellLayer(rectangles, { unknown }))  // the same, built once ahead
//   map.setMarkers([{ latitude, longitude, kind, label }])
//   map.fit('shapes' | 'conus' | { minLatitude, … }, { padding, maxZoom })
//   map.onTap = ({ shapes, coordinate }) => …
//
// Rings are arrays of coordinates, each either `{ latitude, longitude }` or `[lon, lat]`.
// World space is Web Mercator normalised to 0…1 on both axes; the view is a centre and a zoom
// where zoom 0 shows the whole world in 256 CSS pixels.

const TILE = 256
const MIN_ZOOM = 1.5
const MAX_ZOOM = 13
const CONUS = { minLatitude: 24.4, maxLatitude: 49.6, minLongitude: -125, maxLongitude: -66.6 }
const TAP_SLOP = 8
// Radar cells are a wash over the ground, not a layer that hides it: the state lines and the
// place's dot have to stay readable through them (docs/MESHWX_UI.md §3.1 U-47).
const CELL_ALPHA = 0.55

// Everything this map draws is American, and America crosses the date line: the western
// Aleutians and Guam have positive longitudes. They are laid out west of Hawaii, where they are,
// rather than a world away on the far right, so a national picture is one picture.
const westward = (lon) => (lon > 0 ? lon - 360 : lon)
const worldX = (lon) => (westward(lon) + 180) / 360
const worldY = (lat) => {
  const clamped = Math.max(-85, Math.min(85, lat))
  const s = Math.sin((clamped * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}
const lonOf = (x) => { const lon = x * 360 - 180; return lon < -180 ? lon + 360 : lon }
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

const lonLat = (c) => (Array.isArray(c) ? c : [c.longitude, c.latitude])

/**
 * A box of the earth in world space: `{ x, y, width, height }`, y growing southwards.
 *
 * The radar cells come as degrees (`WeatherRadarCells.rectangles`), and they have to land on the
 * same Mercator the basemap is drawn in or the echoes sit beside the state lines instead of over
 * them — so this is the map's own projection and not a second one.
 *
 * The width is taken from the degrees rather than from `worldX(east) - worldX(west)`: east of a
 * tile on the date line is a longitude past 180, and the wrap that lays the Aleutians west of
 * Hawaii would fold it back to the far side of the world and give the box a negative width.
 * Exported for the tests, which have no canvas.
 */
/**
 * A box of degrees in the shape `fit` frames: `{ minLatitude, maxLatitude, minLongitude,
 * maxLongitude }`. Everything that has a south-west and a north-east corner — a radar tile, a
 * product's frame — is framed through this rather than spelling the four names out again.
 */
export function cameraBox({ south, west, north, east }) {
  return { minLatitude: south, maxLatitude: north, minLongitude: west, maxLongitude: east }
}

export function worldRectangle({ south, west, north, east }) {
  const y = worldY(north)
  return { x: worldX(west), y, width: (east - west) / 360, height: worldY(south) - y }
}

/**
 * The radar cells as the map paints them: one path per level, and one for the cells a partial
 * picture does not reach. Null when there is nothing to draw. Built apart from a map so a loop can
 * build each frame's once and hand it to `setCellLayer` on every step.
 */
export function cellLayer(cells, { unknown = [] } = {}) {
  const levels = new Map()
  for (const cell of cells ?? []) {
    let path = levels.get(cell.level)
    if (path == null) levels.set(cell.level, (path = new Path2D()))
    const box = worldRectangle(cell)
    path.rect(box.x, box.y, box.width, box.height)
  }
  let missing = null
  for (const cell of unknown ?? []) {
    missing ??= new Path2D()
    const box = worldRectangle(cell)
    missing.rect(box.x, box.y, box.width, box.height)
  }
  return levels.size || missing ? { levels: [...levels].sort((a, b) => a[0] - b[0]), unknown: missing } : null
}

function pathOf(rings) {
  const path = new Path2D()
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const ring of rings) {
    let first = true
    for (const c of ring) {
      const [lon, lat] = lonLat(c)
      const x = worldX(lon), y = worldY(lat)
      if (first) { path.moveTo(x, y); first = false } else path.lineTo(x, y)
      if (x < box.minX) box.minX = x
      if (x > box.maxX) box.maxX = x
      if (y < box.minY) box.minY = y
      if (y > box.maxY) box.maxY = y
    }
    if (!first) path.closePath()
  }
  return { path, box }
}

export class MapCanvas {
  /**
   * @param {HTMLElement} container sized by CSS; the canvas fills it
   * @param {object} [options]
   * @param {boolean} [options.interactive] pan, zoom and tap (a card preview passes false)
   * @param {boolean} [options.labels] city labels from `setPlaces`
   */
  constructor(container, { interactive = true, labels = true } = {}) {
    this.container = container
    this.interactive = interactive
    this.labels = labels
    this.canvas = document.createElement('canvas')
    this.canvas.setAttribute('role', 'img')
    container.append(this.canvas)
    this.ctx = this.canvas.getContext('2d')

    this.center = { x: worldX(-96), y: worldY(38.5) }
    this.zoom = 3
    this.width = 0
    this.height = 0
    this.base = null
    this.outlines = null
    this.cells = null
    this.shapes = []
    this.markers = []
    this.places = null
    this.selectedID = null
    this.pendingFit = null
    this.onTap = null
    this.onMove = null
    this.frame = 0
    this.destroyed = false

    this.resizer = new ResizeObserver(() => this.#resize())
    this.resizer.observe(container)
    this.scheme = window.matchMedia('(prefers-color-scheme: dark)')
    this.schemeListener = () => { this.colors = null; this.draw() }
    this.scheme.addEventListener('change', this.schemeListener)
    if (interactive) this.#bindInput()
    this.#resize()
  }

  destroy() {
    this.destroyed = true
    this.resizer.disconnect()
    this.scheme.removeEventListener('change', this.schemeListener)
    cancelAnimationFrame(this.frame)
    this.canvas.remove()
  }

  // MARK: Content

  /** The parsed `assets/basemap.json`. */
  setBasemap(basemap) {
    if (!basemap || this.base?.source === basemap) return
    const path = new Path2D()
    const scale = basemap.scale
    for (const state of basemap.states) {
      for (const ring of state.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = worldX(ring[i] / scale), y = worldY(ring[i + 1] / scale)
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y)
        }
        path.closePath()
      }
    }
    this.base = { source: basemap, path }
    this.draw()
  }

  /**
   * Fine outlines drawn when zoomed in: `[{ rings }]` for the counties or zones in view. Optional;
   * the caller decides what is worth passing (the areas of one alert, a state's counties).
   */
  setOutlines(features) {
    this.outlines = features?.length ? pathOf(features.flatMap((f) => f.rings)).path : null
    this.draw()
  }

  /**
   * The radar cells (docs/MESHWX_UI.md §3.1 U-46): `[{ level, south, west, north, east }]` in
   * degrees, one rectangle per run of cells, and `unknown` for the ones a partial picture does not
   * reach.
   *
   * Drawn **over the basemap's fill and under everything else**, so the state lines, the alert
   * outlines, the place's dot and the city labels all read over the weather rather than being
   * buried by it. One path per level, filled once: neighbouring rectangles in one path merge, and
   * a fill per rectangle at 55% would print a darker seam everywhere two of them touch.
   */
  setCells(cells, { unknown = [] } = {}) {
    this.setCellLayer(cellLayer(cells, { unknown }))
  }

  /**
   * A layer `cellLayer` already built, or null for none. The radar loop builds one per frame,
   * once, and steps through them here (revision 13): nothing is rebuilt on a step and the camera
   * never moves.
   */
  setCellLayer(layer) {
    if (this.cells === layer) return
    this.cells = layer ?? null
    this.draw()
  }

  /**
   * `[{ name, state, lat, lon, population }]`, the bundle's places; labels pick from the largest.
   * The bundle's names are in capitals: pass `nameOf` to show them the way the rest of the tool does.
   */
  setPlaces(places, { nameOf = (place) => place.label ?? place.name } = {}) {
    if (!places || this.places?.source === places) return
    const ranked = places.filter((p) => p.population >= 20000).sort((a, b) => b.population - a.population).slice(0, 4000)
    this.places = { source: places, ranked: ranked.map((p) => ({ name: nameOf(p), x: worldX(p.lon), y: worldY(p.lat), population: p.population })) }
    this.draw()
  }

  /**
   * What is drawn over the base, in order (later on top).
   * `{ id, rings, tint, fill = true, stroke = true, dashed = false, data }`; `tint` is a
   * `MeshWXEventTint` name or any CSS colour.
   */
  setShapes(shapes) {
    this.shapes = (shapes ?? []).map((shape) => ({ fill: true, stroke: true, dashed: false, ...shape, ...pathOf(shape.rings ?? []) }))
    if (this.pendingFit?.target === 'shapes') this.fit('shapes', this.pendingFit.options)
    this.draw()
  }

  /** `{ latitude, longitude, kind: 'place' | 'station' | 'bot', label? }` */
  setMarkers(markers) {
    this.markers = (markers ?? []).map((m) => ({ ...m, x: worldX(m.longitude), y: worldY(m.latitude) }))
    this.draw()
  }

  setSelected(id) {
    if (this.selectedID === id) return
    this.selectedID = id
    this.draw()
  }

  // MARK: View

  /**
   * Frames `'shapes'` (and markers), `'conus'`, `'national'` (the lower 48 when anything is shaded
   * there, else the shapes), or a box of `{ minLatitude, maxLatitude,
   * minLongitude, maxLongitude }`. Safe to call before the canvas has a size or before the
   * shapes arrive: it is applied when both exist.
   */
  fit(target = 'shapes', options = {}) {
    const { padding = 28, maxZoom = 9.5 } = options
    let box = null
    if (target === 'national') {
      // The lower 48 when anything is shaded there, so Guam or the Aleutians do not shrink the
      // country to a thumbnail; whatever is shaded when nothing is (a quiet day with one alert
      // in Alaska frames Alaska).
      const home = { minX: worldX(CONUS.minLongitude), maxX: worldX(CONUS.maxLongitude), minY: worldY(CONUS.maxLatitude), maxY: worldY(CONUS.minLatitude) }
      const inside = this.shapes.some((s) => s.box.minX < home.maxX && s.box.maxX > home.minX && s.box.minY < home.maxY && s.box.maxY > home.minY)
      target = inside || !this.shapes.length ? 'conus' : 'shapes'
    }
    if (target === 'shapes') {
      for (const s of this.shapes) box = union(box, s.box)
      for (const m of this.markers) box = union(box, { minX: m.x, maxX: m.x, minY: m.y, maxY: m.y })
      if (!box) { this.pendingFit = { target, options }; target = 'conus' }
    }
    if (target === 'conus') target = CONUS
    if (!box) {
      box = {
        minX: worldX(target.minLongitude), maxX: worldX(target.maxLongitude),
        minY: worldY(target.maxLatitude), maxY: worldY(target.minLatitude),
      }
    } else this.pendingFit = null
    if (!this.width || !this.height) { this.pendingBox = { box, padding, maxZoom }; return }

    const spanX = Math.max(box.maxX - box.minX, 1e-6)
    const spanY = Math.max(box.maxY - box.minY, 1e-6)
    const usableW = Math.max(40, this.width - padding * 2)
    const usableH = Math.max(40, this.height - padding * 2)
    const scale = Math.min(usableW / spanX, usableH / spanY)
    this.zoom = clamp(Math.log2(scale / TILE), MIN_ZOOM, maxZoom)
    this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
    this.pendingBox = null
    this.draw()
  }

  zoomBy(delta, anchor = null) {
    const before = this.zoom
    const after = clamp(before + delta, MIN_ZOOM, MAX_ZOOM)
    if (after === before) return
    if (anchor) {
      // Keep the world point under the cursor where it is.
      const world = this.#toWorld(anchor.x, anchor.y)
      this.zoom = after
      const moved = this.#toWorld(anchor.x, anchor.y)
      this.center = { x: this.center.x + world.x - moved.x, y: this.center.y + world.y - moved.y }
    } else this.zoom = after
    this.draw()
    this.onMove?.()
  }

  get scale() { return TILE * 2 ** this.zoom }

  #toWorld(px, py) {
    const s = this.scale
    return { x: this.center.x + (px - this.width / 2) / s, y: this.center.y + (py - this.height / 2) / s }
  }

  #toScreen(x, y) {
    const s = this.scale
    return { x: (x - this.center.x) * s + this.width / 2, y: (y - this.center.y) * s + this.height / 2 }
  }

  // MARK: Hit testing

  /** The shapes under a canvas point, topmost first. */
  shapesAt(px, py) {
    const world = this.#toWorld(px, py)
    const hits = []
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i]
      if (shape.hitTest === false) continue
      const b = shape.box
      if (world.x < b.minX || world.x > b.maxX || world.y < b.minY || world.y > b.maxY) continue
      // Path2D hit testing runs in the identity transform here, so world units go straight in.
      this.ctx.save()
      this.ctx.setTransform(1, 0, 0, 1, 0, 0)
      const inside = this.ctx.isPointInPath(shape.path, world.x, world.y, 'evenodd')
      this.ctx.restore()
      if (inside) hits.push(shape)
    }
    return hits
  }

  // MARK: Drawing

  draw() {
    if (this.destroyed || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.#paint()
    })
  }

  #resize() {
    const rect = this.container.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    this.width = rect.width
    this.height = rect.height
    this.dpr = dpr
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr))
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr))
    if (this.pendingBox && rect.width && rect.height) {
      const { box, padding, maxZoom } = this.pendingBox
      this.pendingBox = null
      const spanX = Math.max(box.maxX - box.minX, 1e-6), spanY = Math.max(box.maxY - box.minY, 1e-6)
      const scale = Math.min(Math.max(40, rect.width - padding * 2) / spanX, Math.max(40, rect.height - padding * 2) / spanY)
      this.zoom = clamp(Math.log2(scale / TILE), MIN_ZOOM, maxZoom)
      this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
    }
    this.draw()
  }

  #palette() {
    if (this.colors) return this.colors
    // Tokens are `light-dark(…)` expressions (styles/tokens.css), which a canvas cannot parse, so
    // each one is resolved by the browser through a hidden probe: its computed `color` is always a
    // concrete rgb() in whichever theme is in force, forced or followed.
    this.probe?.remove()
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'
    this.container.append(probe)
    const read = (name, fallback) => {
      probe.style.color = ''
      probe.style.color = `var(${name}, ${fallback})`
      return getComputedStyle(probe).color || fallback
    }
    this.colors = {
      water: read('--surface-2', '#e9eef2'),
      land: read('--surface', '#ffffff'),
      border: read('--text-3', '#8a94a0'),
      fine: read('--separator', 'rgba(0,0,0,.1)'),
      text: read('--text', '#111'),
      text2: read('--text-2', '#555'),
      halo: read('--surface', '#fff'),
      accent: read('--accent', '#0b6b88'),
      tint: (name) => read(`--tint-${name}`, name),
      // The three radar levels, which are never an event tint: a radar echo is not a warning,
      // and one palette for both would have a green shower read as a Flood Advisory.
      radar: [
        null,
        read('--radar-light', '#3fa34d'),
        read('--radar-moderate', '#d99000'),
        read('--radar-heavy', '#cc2f26'),
      ],
      radarUnknown: read('--radar-unknown', '#8a94a0'),
    }
    const tint = this.colors.tint
    const tints = new Map()
    // Event tints are asked for by name while painting; resolve each once, then keep it.
    this.colors.tint = (name) => {
      if (!tints.has(name)) tints.set(name, tint(name))
      return tints.get(name)
    }
    this.probe = probe
    return this.colors
  }

  #paint() {
    const { ctx, dpr, width, height } = this
    if (!width || !height) return
    const colors = this.#palette()
    const s = this.scale
    const tx = width / 2 - this.center.x * s
    const ty = height / 2 - this.center.y * s

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = colors.water
    ctx.fillRect(0, 0, width, height)

    ctx.setTransform(s * dpr, 0, 0, s * dpr, tx * dpr, ty * dpr)
    const px = 1 / s
    ctx.lineJoin = 'round'

    if (this.base) {
      ctx.fillStyle = colors.land
      ctx.fill(this.base.path, 'evenodd')
    }
    if (this.cells) this.#paintCells(colors)
    if (this.outlines && this.zoom >= 5.2) {
      ctx.strokeStyle = colors.fine
      ctx.lineWidth = 1 * px
      ctx.stroke(this.outlines)
    }

    for (const shape of this.shapes) {
      const colour = colors.tint(shape.tint ?? 'grey')
      const selected = shape.id != null && shape.id === this.selectedID
      if (shape.fill) {
        ctx.globalAlpha = selected ? 0.62 : (shape.opacity ?? 0.38)
        ctx.fillStyle = colour
        ctx.fill(shape.path, 'evenodd')
      }
      if (shape.stroke) {
        ctx.globalAlpha = selected ? 1 : 0.85
        ctx.strokeStyle = colour
        ctx.lineWidth = (selected ? 2.5 : (shape.lineWidth ?? 1.2)) * px
        ctx.setLineDash(shape.dashed ? [6 * px, 4 * px] : [])
        ctx.stroke(shape.path)
        ctx.setLineDash([])
      }
      ctx.globalAlpha = 1
    }

    if (this.base) {
      ctx.strokeStyle = colors.border
      ctx.globalAlpha = 0.7
      ctx.lineWidth = 0.8 * px
      ctx.stroke(this.base.path)
      ctx.globalAlpha = 1
    }

    // Screen space from here: labels and markers keep their size whatever the zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (this.labels && this.places) this.#paintLabels(colors)
    this.#paintMarkers(colors)
  }

  /**
   * The radar cells, in world space, with the transform the caller left set.
   *
   * The unknown ones are **hatched**, never drawn the way clear ground is: outside a partial
   * tile's bounds there is no reading at all, and a dry-looking cell there would tell somebody
   * their ground is clear on the strength of a picture that stops short of it. The hatch is
   * clipped to the cells and then drawn in *screen* space, so its lines stay the same width at
   * every zoom instead of becoming a wash when the map is zoomed out.
   */
  #paintCells(colors) {
    const { ctx, dpr, width, height } = this
    ctx.globalAlpha = CELL_ALPHA
    for (const [level, path] of this.cells.levels) {
      ctx.fillStyle = colors.radar[level] ?? colors.radar[1]
      ctx.fill(path)
    }
    ctx.globalAlpha = 1
    if (!this.cells.unknown) return
    ctx.save()
    ctx.clip(this.cells.unknown)
    ctx.globalAlpha = 0.16
    ctx.fillStyle = colors.radarUnknown
    ctx.fill(this.cells.unknown)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = colors.radarUnknown
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = -height; x < width; x += 7) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x + height, height)
    }
    ctx.stroke()
    ctx.restore()
    ctx.globalAlpha = 1
  }

  #paintLabels(colors) {
    const { ctx, width, height } = this
    // How many people a town needs before it is named, by zoom: the country shows its big
    // cities, a county shows its towns.
    const floor = this.zoom < 4 ? 900000 : this.zoom < 5 ? 350000 : this.zoom < 6 ? 150000 : this.zoom < 7 ? 60000 : this.zoom < 8 ? 30000 : 20000
    const taken = []
    ctx.font = '500 11px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    let drawn = 0
    for (const place of this.places.ranked) {
      if (place.population < floor) break
      const p = this.#toScreen(place.x, place.y)
      if (p.x < -20 || p.x > width + 20 || p.y < -10 || p.y > height + 10) continue
      const w = ctx.measureText(place.name).width
      const box = { x0: p.x - 4, y0: p.y - 8, x1: p.x + 8 + w, y1: p.y + 8 }
      if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) continue
      taken.push(box)
      ctx.fillStyle = colors.text2
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = colors.halo; ctx.lineWidth = 3; ctx.globalAlpha = 0.85
      ctx.strokeText(place.name, p.x + 6, p.y)
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.text2
      ctx.fillText(place.name, p.x + 6, p.y)
      if (++drawn >= 60) break
    }
  }

  #paintMarkers(colors) {
    const { ctx } = this
    for (const marker of this.markers) {
      const p = this.#toScreen(marker.x, marker.y)
      const colour = marker.kind === 'place' ? colors.accent : colors.text
      ctx.beginPath(); ctx.arc(p.x, p.y, marker.kind === 'place' ? 7 : 5, 0, Math.PI * 2)
      ctx.fillStyle = colors.halo; ctx.fill()
      ctx.beginPath(); ctx.arc(p.x, p.y, marker.kind === 'place' ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fillStyle = colour; ctx.fill()
      if (marker.label) {
        ctx.font = '600 12px system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.strokeStyle = colors.halo; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'
        ctx.strokeText(marker.label, p.x + 10, p.y)
        ctx.fillStyle = colors.text
        ctx.fillText(marker.label, p.x + 10, p.y)
      }
    }
  }

  // MARK: Input

  #bindInput() {
    const canvas = this.canvas
    const pointers = new Map()
    let gesture = null
    canvas.style.touchAction = 'none'
    canvas.style.cursor = 'grab'

    const local = (event) => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId)
      pointers.set(event.pointerId, local(event))
      const points = [...pointers.values()]
      if (points.length === 1) {
        gesture = { kind: 'pan', start: points[0], last: points[0], moved: 0, at: performance.now() }
        canvas.style.cursor = 'grabbing'
      } else if (points.length === 2) {
        gesture = { kind: 'pinch', distance: distance(points[0], points[1]), zoom: this.zoom }
      }
    })

    canvas.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return
      const point = local(event)
      pointers.set(event.pointerId, point)
      if (!gesture) return
      if (gesture.kind === 'pan' && pointers.size === 1) {
        const dx = point.x - gesture.last.x, dy = point.y - gesture.last.y
        gesture.moved += Math.hypot(dx, dy)
        gesture.last = point
        const s = this.scale
        this.center = { x: this.center.x - dx / s, y: clamp(this.center.y - dy / s, 0.05, 0.95) }
        this.draw()
      } else if (gesture.kind === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const ratio = distance(a, b) / Math.max(gesture.distance, 1)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        this.zoomBy(gesture.zoom + Math.log2(ratio) - this.zoom, mid)
      }
    })

    const end = (event) => {
      if (!pointers.has(event.pointerId)) return
      const point = pointers.get(event.pointerId)
      pointers.delete(event.pointerId)
      canvas.style.cursor = 'grab'
      if (gesture?.kind === 'pan' && event.type === 'pointerup' && gesture.moved < TAP_SLOP && performance.now() - gesture.at < 600) {
        const world = this.#toWorld(point.x, point.y)
        this.onTap?.({ shapes: this.shapesAt(point.x, point.y), coordinate: { latitude: latOf(world.y), longitude: lonOf(world.x) }, point })
      } else if (gesture?.kind === 'pan' && gesture.moved >= TAP_SLOP) this.onMove?.()
      gesture = pointers.size === 1 ? { kind: 'pan', start: [...pointers.values()][0], last: [...pointers.values()][0], moved: TAP_SLOP, at: 0 } : null
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault()
      const step = event.ctrlKey ? -event.deltaY / 60 : -event.deltaY / 240
      this.zoomBy(clamp(step, -1, 1), local(event))
    }, { passive: false })

    canvas.addEventListener('dblclick', (event) => this.zoomBy(1, local(event)))

    canvas.tabIndex = 0
    canvas.addEventListener('keydown', (event) => {
      const step = 60 / this.scale
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (moves[event.key]) {
        this.center = { x: this.center.x + moves[event.key][0], y: this.center.y + moves[event.key][1] }
        this.draw(); event.preventDefault()
      } else if (event.key === '+' || event.key === '=') { this.zoomBy(0.5); event.preventDefault() }
      else if (event.key === '-') { this.zoomBy(-0.5); event.preventDefault() }
    })
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const union = (a, b) => (!a ? { ...b } : {
  minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
  minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
})
