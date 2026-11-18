// Port of MC1/Views/Tools/Weather/WeatherConditionsSection.swift
//
// The top of a place's page (docs/MESHWX_UI.md §8): the weather here, set the way a weather app
// sets it — centred, **on the canvas, not in a card** (§3.1.2 V-1).
//
//     MY LOCATION                              ← the first page only
//        86°
//     ☁︎ Cloudy
//     High 92° · Low 71°
//     Feels like 91° · Wind SSE 12 · Humidity 59%
//     Camp Mabry · 6 km · as of 8:24 PM ›      ← opens the station
//     Everything is current · WX-AUS 4:25 PM   ← what Update would ask for (§11.1)
//
// A temperature here is a claim about the weather *here*, so it is shown bare only for a reading
// good enough to make it. One over two hours old (up to twelve) is shown with its age on the foot
// line: "Camp Mabry · 6 km · as of 2:24 PM · 5 h old". A fresh one from 25 to 40 km off is shown under the station it came
// from, named above the number, and the foot line then says only when (§3.1 U-2a). Otherwise the
// block is the sentence that says what to do about it, set as the page's statement rather than as
// a footnote: an 80 pt "--°" placeholder was tried and rejected (V-1).

import { h } from '../kit/dom.js'
import { icon, hasIcon } from '../kit/icons.js'
import { Button, Spinner } from '../kit/components.js'
import { t } from '../../l10n.js'
import { MeshWXPresentation, MeshWXStationObservation, MeshWXWindReading } from '../../meshwx/index.js'
import { WeatherStoredObservation } from '../../weather/index.js'
import { WeatherCoverage, WeatherCoverageVerdict, WeatherEmptyPlace, WeatherNames, WeatherPage } from '../../screen/index.js'
import { updateCaption } from './WeatherUpdateControl.js'
import {
  attempt, conditionsAsk, conditionsSource, condition as conditionWord, emptyPlaceAction,
  emptyPlaceNearest, emptyPlaceTitle, isNight, nearbyReadingLead, noStationNearby, nowOf, placeNameOf,
  planOf, sentenceStart, sourceNameOf, temperature, wind as windText,
} from './support.js'

/**
 * The block, as a Node. Not a screen: it is part of one place page.
 *
 * @param {object} options
 * @param {object} options.app           the tool's app object
 * @param {object} options.screen        this page's `WeatherPageScreen`
 * @param {boolean} [options.showsStatus] false when a banner above already says the one thing the
 *   status line would say (docs/MESHWX_UI.md §3.1 U-24)
 * @param {() => void} options.onUseMyLocation
 * @param {(index: number) => void} options.onOpenStation
 */
export function WeatherConditionsSection({ app, screen, showsStatus = true, onUseMyLocation, onOpenStation }) {
  const snapshot = screen?.snapshot ?? null
  const isMyLocation = screen?.pageID === WeatherPage.myLocationID

  return h('div', { class: 'hero' },
    isMyLocation && snapshot?.place != null ? eyebrow() : null,
    block({ app, screen, onUseMyLocation, onOpenStation }),
    // The bot pushes warnings for its own area only, so outside it silence says nothing. One
    // quiet line, and never "no alerts for Dallas", which the phone cannot know (§3.2 Q14). The
    // phone's wording ends "pull to check"; here the check is the Update button (§11.1).
    isOutsideArea(snapshot) ? h('p', { class: 'hero__caption' }, t('web.place.outsideArea')) : null,
    showsStatus ? status({ app, screen }) : null)
}

/** "MY LOCATION", with the arrow the dots use for the same page. */
function eyebrow() {
  return h('div', { class: 'page-eyebrow' },
    icon('location.fill', { size: 12 }),
    h('span', null, t('weather.picker.yourLocation')))
}

function isOutsideArea(snapshot) {
  const place = snapshot?.place
  if (place == null || snapshot?.coverage == null) return false
  return attempt(() => WeatherCoverage.verdict(snapshot.coverage, { for: place })) === WeatherCoverageVerdict.outside
}

/**
 * What Update would ask for; while a run is on the air, what it said; with nothing to ask, that
 * everything is current and as of when (docs/MESHWX_UI.md §11.1, §3.1.2 V-5).
 */
function status({ app, screen }) {
  const text = updateCaption({ app, screen, plan: planOf(screen) })
  if (!text) return null
  return h('p', { class: 'hero__caption', dataset: { test: 'weather.page.caption' } }, text)
}

function block({ app, screen, onUseMyLocation, onOpenStation }) {
  const snapshot = screen?.snapshot ?? null
  const context = screen?.context ?? null
  const conditions = context?.conditions ?? null

  // A page that would say no to everything says it once (docs/MESHWX_UI.md §3.1 U-13).
  const empty = attempt(() =>
    conditions == null || snapshot?.forecast == null
      ? null
      : WeatherEmptyPlace.make({ conditions, forecast: snapshot.forecast }))
  if (empty != null) return emptyBlock({ screen, empty })

  switch (conditions?.kind) {
    case 'reading':
      return readingBlock({ app, screen, reading: conditions.value, attributed: false, onOpenStation })
    case 'nearby':
      return readingBlock({ app, screen, reading: conditions.value, attributed: true, onOpenStation })
    case 'ask':
      // With every request blocked the sentence stops offering the pull (§3.1 U-6). On the web
      // there is no pull at all: `WeatherCopy` names the station either way and Update is the
      // refresh (§11.1).
      return statement(conditionsAsk({
        placeName: placeNameOf(screen) ?? '',
        source: sourceNameOf(screen),
        icao: conditions.icao,
        block: snapshot?.requestBlock ?? null,
      }))
    case 'noneYet':
      return statement(t('weather.now.empty', sentenceStart(sourceNameOf(screen))))
    case 'noStation':
      return statement(noStationNearby({
        placeName: placeNameOf(screen) ?? '',
        nearestTown: context?.nearestStationTown
          ?? attempt(() => WeatherNames.stationName(conditions.nearest?.station?.name))
          ?? '',
        kilometres: conditions.nearest?.distanceKilometres ?? null,
      }))
    case 'noPlace':
      return noPlaceBlock({ app, screen, onUseMyLocation })
    default:
      // No build for this page yet. The page's own loading state says so; nothing here invents a
      // reading or a refusal.
      return null
  }
}

/** What the page has to say in place of a temperature, set as its statement. */
function statement(text) {
  if (!text) return null
  return h('p', { class: 'hero__ask' }, text)
}

function sentence(text) {
  if (!text) return null
  return h('p', { class: 'hero__sentence' }, text)
}

// MARK: - A good reading

function readingBlock({ app, screen, reading, attributed, onOpenStation }) {
  const observation = reading?.stored?.observation ?? null
  if (observation == null) return null
  const timeZone = app?.timeZone
  const locale = app?.locale
  const observedAt = attempt(() => WeatherStoredObservation.observedAt(reading.stored))
  const symbol = attempt(() => MeshWXPresentation.observationSymbolName({
    for: observation.sky,
    isNight: isNight(observedAt, { timeZone }) === true,
  }))
  const word = conditionWord(observation.sky)
  const degrees = observation.temp_f == null ? null : temperature(observation.temp_f, { locale })

  return h('div', { class: 'hero__block' },
    // The reading is not the weather here, only the nearest report: the station and its distance
    // lead, above the number, so nobody reads 79° as the town's (§3.1 U-2a).
    attributed
      ? h('p', { class: 'hero__lead' }, nearbyReadingLead({
        stationName: attempt(() => WeatherNames.stationName(reading.station?.name)) ?? '',
        kilometres: reading.distanceKilometres ?? null,
      }))
      : null,
    degrees != null ? h('div', { class: 'hero__temp' }, degrees) : null,
    symbol != null || word != null
      ? h('div', { class: 'hero__condition' },
        symbol != null ? icon(hasIcon(symbol) ? symbol : 'cloud', { size: 26 }) : null,
        word != null ? h('span', null, word) : null)
      : null,
    highLow({ screen, locale }),
    details({ observation, locale }),
    sourceLine({ app, screen, reading, attributed, observedAt, onOpenStation }))
}

/** Today's high and low, from the forecast the page holds. Nothing when there is none yet. */
function highLow({ screen, locale }) {
  const forecast = screen?.snapshot?.forecast
  if (forecast?.kind !== 'forecast') return null
  const rows = forecast.value?.rows ?? []
  const row = rows.find((one) => one.label?.kind === 'today' || one.label?.kind === 'tonight') ?? rows[0]
  if (row == null) return null
  const parts = []
  if (row.highF != null) parts.push(t('weather.forecast.high', temperature(row.highF, { locale })))
  if (row.lowF != null) parts.push(t('weather.forecast.low', temperature(row.lowF, { locale })))
  if (parts.length === 0) return null
  return h('div', { class: 'hero__range' }, parts.join(' · '))
}

function details({ observation, locale }) {
  const parts = []
  const feelsLike = attempt(() => MeshWXStationObservation.feelsLikeF(observation))
  if (observation.feels_delta_f !== 0 && feelsLike != null) {
    parts.push(t('weather.now.feelsLike', temperature(feelsLike, { locale })))
  }
  const speed = windText(attempt(() => MeshWXWindReading.make({ observation })))
  if (speed) parts.push(t('weather.now.wind', speed))
  if (observation.humidity_pct != null) parts.push(t('weather.now.humidity', Math.trunc(observation.humidity_pct)))
  if (parts.length === 0) return null
  // One run of text, joined as the Swift joins it, so the line wraps between clauses on a phone
  // rather than leaving a middot stranded at the end of a row.
  return h('div', { class: 'hero__details' }, h('span', null, parts.join(' · ')))
}

/**
 * The one honesty line, and the way to the station behind it (docs/MESHWX_UI.md §3.2 Q5). With
 * `attributed` the station and distance already lead the block, so this says when only. A stale
 * reading's line ends with its age, in the stale colour the stations list uses for the same thing.
 */
function sourceLine({ app, screen, reading, attributed, observedAt, onOpenStation }) {
  const isStale = reading?.isStale === true
  const text = conditionsSource({
    stationName: attributed ? null : attempt(() => WeatherNames.stationName(reading.station?.name)),
    kilometres: attributed ? null : reading.distanceKilometres ?? null,
    observedAt,
    now: nowOf(screen, app),
    timeZone: app?.timeZone,
    locale: app?.locale,
    isStale,
  })
  if (!text) return null
  return h('button', {
    class: isStale ? 'hero__station hero__station--stale' : 'hero__station',
    type: 'button',
    dataset: { test: 'weather.honestyLine' },
    onclick: () => onOpenStation?.(reading.index),
  }, h('span', null, text), icon('chevron.right', { size: 14 }))
}

// MARK: - Nothing held at all

/**
 * Everything the phone holds for this place is missing: one calm card — what is nearest, and the
 * one thing to do about it (docs/MESHWX_UI.md §3.1 U-13). `WeatherCopy.emptyPlaceAction` returns
 * nothing while every request is blocked, so the reason is said once, by the status line.
 */
function emptyBlock({ screen, empty }) {
  const name = placeNameOf(screen) ?? ''
  return h('div', { class: 'hero__block' },
    h('p', { class: 'hero__headline' }, emptyPlaceTitle({ placeName: name }) ?? ''),
    sentence(emptyPlaceNearest(empty)),
    sentence(emptyPlaceAction(empty, {
      placeName: name,
      source: sourceNameOf(screen),
      block: screen?.snapshot?.requestBlock ?? null,
    })))
}

// MARK: - No place

/**
 * The My location page before there is a place (docs/MESHWX_UI.md §5). **Nothing prompts for
 * location on its own**: the button is the one tap that may ask.
 */
function noPlaceBlock({ app, screen, onUseMyLocation }) {
  const state = attempt(() => app?.model?.placeState) ?? 'needsPermission'
  const useMyLocation = () => onUseMyLocation?.()

  switch (state) {
    case 'locating':
      return h('div', { class: 'hero__locating' }, Spinner(), h('span', null, t('weather.header.locating')))
    case 'denied':
      return h('div', { class: 'hero__block' },
        statement(t('weather.header.locationOff')),
        sentence(t('web.place.locationDeniedHint')))
    case 'needsPermission':
      // Places opens by itself on a first visit with no permission and no saved place, so this
      // page is read *under* that sheet. It offers the one thing the sheet does not: the tap that
      // asks for location (docs/MESHWX_UI.md §3.1 U-19).
      return h('div', { class: 'hero__block' },
        statement(t('weather.place.useMyLocationPrompt')),
        h('div', { class: 'hero__action' }, Button({ label: t('weather.place.useMyLocation'), onclick: useMyLocation })))
    default:
      return h('div', { class: 'hero__block' },
        statement(t('weather.place.choosePrompt')),
        h('div', { class: 'hero__action' }, Button({ label: t('weather.place.useMyLocation'), onclick: useMyLocation })))
  }
}
