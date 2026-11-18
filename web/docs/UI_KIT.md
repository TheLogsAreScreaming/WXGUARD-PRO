# The UI kit

No framework. A screen builds DOM with `h`, the navigation re-renders the screen that is on top
whenever the model changes, and `morph` brings the live tree up to date without losing scroll
position or focus. Everything lives in `src/ui/kit/`.

## A screen

```js
export function WeatherStationsScreen({ app, page }) {
  return {
    id: 'stations',
    title: () => t('weather.stations.title'),
    render: () => List(Card({ label: … }, rows…)),   // called again on every refresh; keep it pure
    trailing: () => null,                            // bar's trailing item, optional
    toolbar: () => null,                             // bottom bar, only the root has one
    fullBleed: false,                                // true for a full-screen map
    onAppear() {}, onDisappear() {}, onRemove() {},
  }
}
```

- `app.nav.push(screen)`, `app.nav.pop()`, `app.nav.sheet({ title, render, onDismiss })`,
  `app.nav.closeSheets()`, `app.nav.refresh()`. Pushes and sheets are browser history entries, so
  Back closes them.
- **One sheet at a time.** A sheet presented over another cannot be taken apart again: closing the
  inner one sends a back that the outer one answers as well, and both go. A screen reached from a
  sheet is pushed after `await app.nav.closeSheets()` (the radio settings screen, from the connect
  sheet), never stacked on it.
- `render()` reads from the model every time and keeps no copy of model data. Screen-local state
  (a search string, which tab is picked) lives in the closure; after changing it call
  `app.nav.refresh()`.
- **A pushed screen is bound to its page** (`MESHWX_UI.md`, the rule that came out of the
  16 September failure): it receives the page's key or screen object and reads *that* page's
  snapshot and context, never "the model's current snapshot".
- Give list children a stable `key` (`Row({ key: identityKey })`) whenever the list can reorder,
  grow or shrink; `morph` matches keyed children by key and the rest by position.

## Building blocks (`components.js`)

`List`, `Card({ label, labelTrailing, foot })`, `Row({ icon, title, subtitle, value, trailing,
onclick, stale, destructive, muted, tint, key })`, `Button({ label, icon, kind, small, onclick })`,
`Banner({ text, detail, actions, kind: 'warning'|'info'|'success'|'error' })`, `EmptyState`,
`confirmAction`, `toast`, `Field`, `Select`, `Switch`, `Spinner`, `Empty`, `Prose`, `Note`,
`openMenu(anchor, items)`. They map onto the classes of `styles/app.css`; read that file before
adding a class, and add new classes there, grouped under a comment for your screen. Colours, type,
spacing and motion are tokens from `styles/tokens.css`; see `docs/DESIGN_SYSTEM.md`.

## Fields: a row you type in or choose from

`Field({ label, value, unit, detail, inputmode, oninput, invalid, wide, key })` and
`Select({ label, value, options, onchange, detail, invalid, key })` are rows whose value sits on
the right where a `Row`'s value would, so a card of fields reads as a card of rows. `Select`'s
`options` is `[{ value, label, disabled? }]`, or `[{ group, options: [...] }]` for an `optgroup`.

- `value` comes from the screen's own state on **every** render, like everything else. `morph`
  keeps a live input in step with it and leaves it alone while it has focus, so a field needs no
  `data-static` and no `hook` — unlike the search field, which is its own thing.
- `Field` is always `type="text"` with an `inputmode`, never `type="number"`: a number input
  reports `""` for anything it dislikes, so "910." mid-typing comes back as nothing and the digits
  already entered are lost. Parse and range-check in the caller, which is the only place that knows
  what the field is for, and pass `invalid` to paint the border.
- Keep a `Select`'s option list stable across renders: `morph` sets the select's value before it
  updates the options, so a value whose option has only just appeared would not take.

Event colours: set `--tint` from a `MeshWXEventTint` name, `style="--tint: var(--tint-orangeRed)"`
(`Row({ tint })` does it). Icons: `icon('cloud.sun', { size })` from `icons.js`, named after the
SF Symbols the iOS code uses. Text: `t(key, ...args)` from `src/l10n.js`, never typed English.

## Things that must survive a re-render

A canvas map or a text field being typed in must not be rebuilt. Mark the element `data-static`
and give it a `key` and a `hook`:

```js
h('div', { class: 'map', key: 'map', 'data-static': '', hook: (el) => {
  const map = new MapCanvas(el, { interactive: true })
  state.map = map
  return () => { map.destroy(); state.map = null }     // runs when the element leaves the page
} })
```

`hook` runs once after the element is in the document. `morph` leaves a `data-static` element
alone from then on, so push new content into it from `render()` yourself
(`state.map?.setShapes(shapes)`), guarded by a cheap fingerprint so identical renders do nothing.

## The map (`MapCanvas.js`)

Offline, canvas, no tiles: state outlines from `assets/basemap.json`, city labels from the
bundle's places, and whatever shapes you give it. `setBasemap`, `setPlaces`, `setOutlines`,
`setShapes([{ id, rings, tint, fill, stroke, dashed, data }])`, `setCells`, `setMarkers`,
`setSelected(id)`, `fit('shapes' | 'conus' | box, { padding, maxZoom })`,
`onTap = ({ shapes, coordinate }) => …`. Rings are arrays of `{ latitude, longitude }` or
`[lon, lat]`. `app.basemap` holds the parsed basemap once it has loaded.

A shape with `fill: false` is an **outline only** — how the radar screen draws the alerts it is
holding, so the cells under them can still be read. `fit` also takes an explicit box,
`{ minLatitude, maxLatitude, minLongitude, maxLongitude }`; `cameraBox({ south, west, north, east })`
builds one from the two corners a radar tile names.

**Radar cells.** `setCells(rectangles, { unknown })` takes `[{ level, south, west, north, east }]`
in degrees — `WeatherRadarCells.rectangles` — and projects each through the map's own Mercator, so
the echoes land on the state lines rather than beside them. They are drawn over the basemap's fill
and under the outlines, the shapes, the labels and the markers; filled at 55% with no stroke, one
path per level so two touching rectangles do not print a seam. `unknown` (the cells a partial tile
does not reach) is hatched in `--radar-unknown`, never anything that reads as dry ground. The
three level colours are `--radar-light`, `--radar-moderate`, `--radar-heavy`, which are not, and
must never be, the `--tint-*` alert colours. `worldRectangle({ south, west, north, east })` is the
projection on its own, exported for tests that have no canvas.

**A layer built ahead.** `cellLayer(rectangles, { unknown })` builds the same paths without a map,
and `setCellLayer(layer)` shows one (null for none) without rebuilding or re-framing anything. The
radar screen's loop builds each frame's layer once and steps through them; a drawing
handed to `applyDrawing` with a `cellLayer` key has it pushed on every paint, outside the
fingerprint, so a step never moves the camera.

## Layout

Mobile first, one column (`--column`), the same on a desktop: weather is read, not tiled. 16 px
gutters, 44 px minimum targets, both colour schemes through the `light-dark()` tokens in
`styles/tokens.css`, no fixed heights on text, `prefers-reduced-motion` respected. Nothing may be fetched from another origin:
no web fonts, no CDN, no tiles. The tool is for places without internet.
