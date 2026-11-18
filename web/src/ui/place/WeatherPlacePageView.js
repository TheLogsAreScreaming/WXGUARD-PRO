// Port of MC1/Views/Tools/Weather/WeatherPlacePageView.swift
//
// One place's page (docs/MESHWX_UI.md §4, §5): one list, top to bottom, answering "what's the
// weather here".
//
//     MY LOCATION
//        86°  ☁︎ Cloudy · High 92° · Low 71°        (on the canvas, not in a card)
//     Camp Mabry · 6 km · as of 8:24 PM ›
//     Everything is current · WX-AUS 4:25 PM        (what Update would ask for)
//     ⚠︎ Tornado Warning · until 9:41 PM             (only when one covers this place)
//     FORECAST · ISSUED 4:02 PM  ‹ rows ›
//     WEATHER SERVICE TEXT REPORTS  ‹ rows ›
//     WX-AUS · heard 2 min ago · alerts as of 8:02 PM ›
//
// No section appears or vanishes with the coverage verdict except the out-of-area line and the
// banner's absence, so the page is the same shape every time it is opened (§3.2 Q3, Q7). Nothing
// here asks the radio by itself: Update is the only way the page spends airtime (§11.1).
//
// Everything reachable from here **pushes**; Places is the only sheet in the tool (§3.1 U-11).
// Every push carries **this page**, so the screen it opens answers for this place and never for
// whichever page the pager has since landed on (§3.1 U-18).

import { h } from '../kit/dom.js'
import { icon, hasIcon } from '../kit/icons.js'
import { Banner, Button, Card, List, Row, Spinner } from '../kit/components.js'
import { t } from '../../l10n.js'
import { MeshWXTables } from '../../meshwx/index.js'
import {
  WeatherAlertItem, WeatherEmptyPlace, WeatherPage, WeatherPlaceRowReading, WeatherRadioRow, WeatherSavedPlace,
} from '../../screen/index.js'
import { WeatherConditionsSection } from './WeatherConditionsSection.js'
import { WeatherForecastSection } from './WeatherForecastSection.js'
import { WeatherRadarSection } from './WeatherRadarSection.js'
import {
  alertQualifier, attempt, bannerText, eventName, eventSymbol, eventTint, nowOf, placeNameOf, placeRowText,
  radioRowText, screenFor, sourceNameOf, alertWindow, WeatherReportProduct,
} from './support.js'

/**
 * One page of the pager, as a Node.
 *
 * @param {object} options
 * @param {object} options.app
 * @param {object} options.page  a `WeatherPage` from `model.pages`
 * @param {() => void} options.onUseMyLocation
 */
export function WeatherPlacePageView({ app, page, onUseMyLocation }) {
  const pageID = attempt(() => WeatherPage.id(page))
  // This page's own build, and nothing else's.
  const screen = screenFor(app, pageID)
  if (screen?.snapshot == null) return List(preview({ app, page }))

  const push = pushers({ app, screen, pageID })
  const snapshot = screen.snapshot
  // **A blocking reason is said once per screen** (docs/MESHWX_UI.md §3.1 U-24). A banner is the
  // loudest thing on the list and carries it whenever there is one. A disconnected radio is the
  // web's own case: §11.2 puts "Connect your radio to ask WX-AUS" *in place of* the button, and
  // here that place is a control that opens the connect sheet — so the toolbar has said it and
  // the caption stands down rather than printing the same sentence above a button that fixes it.
  const bannerSaysTheBlock = snapshot.requestBlock != null && snapshot.banner != null
  const connectSaysTheBlock = snapshot.requestBlock === 'radioOffline' && typeof app?.openConnect === 'function'
  const warning = screen.context?.banner ?? null
  const empty = attempt(() =>
    screen.context?.conditions == null || snapshot.forecast == null
      ? null
      : WeatherEmptyPlace.make({ conditions: screen.context.conditions, forecast: snapshot.forecast }))

  return List(
    // Something about the radio blocks weather altogether: said first, above everything.
    snapshot.banner != null ? WeatherRadioBannerSection({ app, banner: snapshot.banner }) : null,

    WeatherConditionsSection({
      app,
      screen,
      showsStatus: !bannerSaysTheBlock && !connectSaysTheBlock,
      onUseMyLocation,
      onOpenStation: push.station,
    }),

    // Under the weather, where a weather app puts it (§3.2 Q1, Q7).
    warning != null
      ? WeatherWarningBannerSection({ app, screen, banner: warning, onOpen: push.alert, onOpenList: push.alerts })
      : null,

    // Nothing held for this place at all: the block above already says so, once, and names what is
    // nearest (§3.1 U-13). With no place at all it is already the whole of what the page can say.
    empty == null && screen.context?.conditions?.kind !== 'noPlace'
      ? WeatherForecastSection({ app, screen })
      : null,

    // Under the forecast (docs/MESHWX_UI.md §18.1), and absent altogether for a place with no
    // coordinate: a radar tile is decided by a coordinate and by nothing else.
    WeatherRadarSection({ app, screen, onOpen: push.radar }),

    reports({ push }),

    WeatherRadioRowSection({ app, screen, onOpen: push.radio }))
}

/**
 * The Weather Service products, as rows that open the text (docs/MESHWX_UI.md §12). They are the
 * only thing below the forecast: the stations, the alerts in the wider area and everything about
 * the radio moved to the radio page (§3.2 Q8).
 */
function reports({ push }) {
  return Card({ label: t('weather.reports.title') },
    WeatherReportProduct.map((product) => Row({
      key: product.id,
      title: t(product.titleKey),
      onclick: () => push.report(product.subject),
    })))
}

/**
 * A page the snapshot does not speak for: its name and what the phone already holds for it, which
 * is what a Places row shows. It fills in as soon as the swipe settles.
 */
function preview({ app, page }) {
  const model = app?.model ?? null
  const saved = attempt(() => WeatherPage.savedPlace(page))
  const label = saved?.label ?? null
  const coordinate = saved != null
    ? attempt(() => WeatherSavedPlace.coordinate(saved))
    : attempt(() => model?.latestSample?.coordinate)
  const reading = coordinate == null
    ? null
    : attempt(() => WeatherPlaceRowReading.make({
      readings: attempt(() => model?.snapshot?.readings) ?? [],
      at: coordinate,
      now: model?.now ?? Date.now(),
    }))
  const text = reading == null
    ? t('weather.picker.noReading')
    : placeRowText(reading, { now: model?.now ?? Date.now(), locale: app?.locale })

  return h('div', { class: 'page-preview', role: 'status' },
    label != null ? h('p', { class: 'page-preview__name' }, label) : null,
    Spinner(),
    h('p', { class: 'footnote' }, text))
}

// MARK: - The warning banner (§7)

/**
 * The one strip under the weather, **always the same height**: the alert covering this place, when
 * it ends, and a count of any others. Tapping it opens the alert when it is the only one, and the
 * alerts list when there are others, whose first section is exactly the alerts covering this place
 * (§3.1 U-50): a count that opened one of them would hide the rest. There is no card, ever — a page
 * that rearranges itself in a storm is a page whose shape cannot be learned (§3.2 Q7).
 */
export function WeatherWarningBannerSection({ app, screen, banner, onOpen, onOpenList }) {
  const item = banner?.item
  if (item == null) return null
  const tables = app?.tables ?? attempt(() => MeshWXTables.shared)
  const event = item.warning?.event
  const tint = eventTint({ for: event, tables })
  const symbol = eventSymbol({ for: event, tables })
  const name = eventName(event, { tables }) ?? ''

  // "until 9:41 PM · 40 min left" for a live warning, "from Wed 7:00 PM until Fri 7:00 PM" for a
  // watch not yet in effect (spec §18.2, revision 12); for one that just ended, or an upgrade
  // whose replacement never came, what became of it instead.
  const now = nowOf(screen, app)
  const qualifier = alertQualifier(item, { placeName: placeNameOf(screen), now })
    ?? alertWindow({
      beginsAt: item.beginsAt ?? null,
      expiresAt: attempt(() => WeatherAlertItem.expiresAt(item)),
      now,
      timeZone: app?.timeZone,
      locale: app?.locale,
    })

  return h('button', {
    class: 'alert-strip',
    type: 'button',
    style: `--tint: var(--tint-${tint})`,
    dataset: { test: 'weather.warningBanner' },
    onclick: () => ((banner.more ?? 0) > 0 ? onOpenList?.() : onOpen?.(item.identity)),
  },
    // `MeshWXPresentation` names SF Symbols the offline icon set does not all draw (tornado,
    // snowflake, wind): the warning triangle stands in rather than the kit's placeholder dot.
    icon(hasIcon(symbol) ? symbol : 'exclamationmark.triangle', { size: 22 }),
    h('span', { class: 'alert-strip__main' },
      h('span', { class: 'alert-strip__name' }, name),
      qualifier ? h('span', { class: 'alert-strip__when' }, qualifier) : null),
    (banner.more ?? 0) > 0 ? h('span', { class: 'alert-strip__more' }, t('weather.alerts.more', banner.more)) : null,
    h('span', { class: 'row__chevron' }, icon('chevron.right', { size: 16 })))
}

// MARK: - The radio row (§10)

/**
 * The last row on every page, and the way to the radio page. It is the only thing here that says
 * anything about the alert list, and it turns **orange** when that list is old or missing, or when
 * this phone missed messages: the page above says nothing on a quiet day, so this row is where
 * "nothing said" stops meaning "nothing happening".
 */
export function WeatherRadioRowSection({ app, screen, onOpen }) {
  const row = screen?.context?.radioRow
  if (row == null) return null
  const needsAttention = attempt(() => WeatherRadioRow.needsAttention(row)) === true
  const text = radioRowText(row, {
    source: sourceNameOf(screen),
    now: nowOf(screen, app),
    timeZone: app?.timeZone,
    locale: app?.locale,
  })
  return Card({ class: 'card--radio' },
    Row({
      icon: 'antenna.radiowaves.left.and.right',
      title: text ?? sourceNameOf(screen),
      stale: needsAttention,
      onclick: () => onOpen?.(),
      class: 'radio-row',
    }))
}

// MARK: - Radio banners (§10)

/** At most one banner, only when something about the radio blocks weather altogether. */
export function WeatherRadioBannerSection({ app, banner }) {
  const model = app?.model ?? null
  const text = bannerText(banner)
  if (!text) return null
  const actions = []
  if (banner?.kind === 'channelMissing' && attempt(() => model?.isChannelSyncDone) === true) {
    actions.push(Button({
      label: t('weather.banner.addChannel'),
      small: true,
      disabled: attempt(() => model?.isAddingChannel) === true,
      onclick: () => confirmAddChannel(model),
    }))
  }
  return Banner({
    icon: banner?.kind === 'noBotHeard' ? 'antenna.radiowaves.left.and.right' : 'exclamationmark.triangle.fill',
    text,
    actions,
  })
}

/**
 * The confirmation §3 C-B3 asked for: a modal the banner cannot take with it when it disappears.
 * The browser's own is that modal, and the write happens only after it is gone.
 */
function confirmAddChannel(model) {
  const message = `${t('weather.channel.alert.title')}\n\n${t('weather.channel.alert.message')}`
  if (typeof window !== 'undefined' && !window.confirm(message)) return
  attempt(() => model?.addChannel?.())
}

// MARK: - Pushes

/**
 * Every screen this page opens, each handed **this page**. The radio side of the tool is another
 * engineer's, so those modules are imported at the tap: a place page still loads and still renders
 * while they are being written.
 */
function pushers({ app, screen, pageID }) {
  const page = screen ?? pageID
  const open = async (load) => {
    const built = await attemptAsync(load)
    if (built != null) app?.nav?.push?.(built)
  }
  return {
    station: (index) => open(async () => {
      const { WeatherStationScreen } = await import('./WeatherStationsView.js')
      return WeatherStationScreen({ app, page, index })
    }),
    alert: (identity) => open(async () => {
      const { WeatherAlertDetailScreen } = await import('../radio/index.js')
      return WeatherAlertDetailScreen({ app, page, identity })
    }),
    alerts: () => open(async () => {
      const { WeatherAlertsListScreen } = await import('../radio/index.js')
      return WeatherAlertsListScreen({ app, page })
    }),
    report: (subject) => open(async () => {
      const { WeatherReportScreen } = await import('../radio/index.js')
      return WeatherReportScreen({ app, page, subject })
    }),
    radio: () => open(async () => {
      const { WeatherRadioScreen } = await import('../radio/index.js')
      return WeatherRadioScreen({ app, page })
    }),
    radar: () => open(async () => {
      const { WeatherRadarScreen } = await import('../radio/index.js')
      return WeatherRadarScreen({ app, page })
    }),
  }
}

async function attemptAsync(fn) {
  try {
    return await fn()
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[place] could not open the screen', error)
    return null
  }
}
