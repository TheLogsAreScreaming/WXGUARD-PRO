// Port of MC1/Views/Tools/Weather/WeatherRadioView.swift.
//
// The weather radio's own page (docs/MESHWX_UI.md §12), **pushed** from the radio row at the foot
// of a place page: how asking works, what the radio says it covers, what this phone has asked
// for, what the channel has carried, the radios themselves, and what is being kept.
//
// One screen for the radio and the channel, in place of the About sheet. Nothing on it says who
// asked for anything: an answer on `#meshwx` reaches every phone listening and carries no
// requester, so the only requests that can be listed are this phone's own.
//
// The order is §3.1 U-16: How it works · What it covers · Your requests · Weather stations ·
// Alerts in its area · Alert notifications · Cached from the channel · the channel · the radios ·
// Clear — with one card the phone has no need of, below.
import { h } from '../kit/dom.js'
import { Button, Card, List, Prose, Row } from '../kit/components.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { MeshWXCoverage } from '../../meshwx/index.js'
import { WeatherNames } from '../../screen/index.js'
import { WeatherChannel, WeatherRequest } from '../../weather/index.js'
import { WeatherFormatting, WeatherReferenceNames } from '../../app/index.js'
import { copy, Line, safeScreen } from './support.js'
import { AskButton, PendingBar } from './WeatherAskControl.js'
import { WeatherAlertsListScreen } from './WeatherAlertsListView.js'
import { WeatherAlertNotificationsScreen } from './WeatherAlertNotificationsView.js'
import { WeatherCachedScreen } from './WeatherCachedView.js'
import { RequestRow, WeatherRequestsScreen } from './WeatherRequestsView.js'
import { WeatherTrafficScreen } from './WeatherTrafficView.js'

/** The place side owns the station screens; link to them by name, lazily. */
async function pushPlaceScreen(app, name, props) {
  try {
    const module = await import('../place/index.js')
    const factory = module?.[name]
    if (typeof factory !== 'function') return
    app.nav.push(factory(props))
  } catch (error) {
    if (typeof console !== 'undefined') console.error('[weather.radio] no place screen', name, error)
  }
}

export function WeatherRadioScreen({ app, page }) {
  // The town at the centre of the stated circle. Thirty-five thousand place names, so the answer
  // is kept: the statement does not move while the screen is open.
  let centreKey = null
  let centreName = null
  // "How it works" is read once and then in the way: folded by default, one tap to open.
  let showsHowItWorks = false

  const statement = () => {
    const botID = page?.snapshot?.source?.botID ?? null
    if (botID == null) return null
    return page?.snapshot?.coverage?.stated?.[String(botID)] ?? null
  }

  /** "Within 120 km of Austin, TX", or of the degrees the bot sent when no town is near enough. */
  const circle = (coverage, words) => {
    const centre = MeshWXCoverage.centre(coverage)
    if (centre == null || !(coverage.radius_km > 0)) return null
    const key = `${centre.latitude},${centre.longitude}`
    if (centreKey !== key) {
      centreKey = key
      centreName = WeatherNames.placeLabel({ near: centre, tables: app.tables })
    }
    const place = centreName ?? coordinates(centre)
    return t('weather.covers.circle', words.kilometres(coverage.radius_km), place)
  }

  /**
   * How many zones the statement lists. A list the bot had to cut says "and more it didn't list",
   * never that the rest are uncovered (spec §10).
   */
  const zones = (coverage) => {
    if ((coverage.areas ?? []).length === 0) return null
    const count = coverage.areas.reduce((total, run) => total + run.run, 0)
    const text = count === 1 ? t('weather.covers.zoneCountOne') : t('weather.covers.zoneCount', count)
    return coverage.zones_cut ? t('weather.covers.andMore', text) : text
  }

  const offices = (coverage) => {
    if ((coverage.offices ?? []).length === 0) return null
    const names = coverage.offices
      .map((index) => app.tables?.officeCode?.(index) ?? null)
      .filter((code) => code != null)
      .map((code) => WeatherReferenceNames.officeName(code))
    if (names.length === 0) return null
    const text = names.join(', ')
    return coverage.offices_cut ? t('weather.covers.andMore', text) : text
  }

  const botDetail = (row, words) => {
    const parts = []
    // "heard" only for live traffic; a radio known only from a drained backlog says nothing.
    if (row.lastLiveHeardAt != null) parts.push(t('weather.about.heard', words.ago(row.lastLiveHeardAt)))
    else if (row.lastHeardAt == null) parts.push(t('weather.about.notHeard'))
    switch (row.feed?.kind) {
      case 'recent': parts.push(t('weather.about.feedOK')); break
      case 'quiet': parts.push(t('weather.about.feedQuiet', words.quietDuration(row.feed.minutes))); break
      case 'neverReceived': parts.push(t('weather.about.feedNone')); break
      default: break
    }
    if (row.bot == null) parts.push(t('weather.about.noAdvert'))
    if (page?.snapshot?.source?.botID === row.botID) parts.push(t('weather.about.inUse'))
    return parts.join(' · ')
  }

  const checkRow = ({ key, title, detail, isSelected, disabled, onclick }) => Row({
    key,
    title,
    subtitle: detail,
    chevron: false,
    disabled,
    onclick,
    trailing: isSelected
      ? h('span', { class: 'row__check' }, icon('checkmark.circle.fill', { size: 20, label: t('weather.common.selected') }))
      : null,
  })

  /**
   * The confirmation names the bot it was opened for, fixed at that moment: the source can change
   * while the sheet is up, and the clear must remove what the sheet said it would.
   */
  const confirmClear = () => {
    const botID = page?.snapshot?.source?.botID ?? null
    if (botID == null) return
    const name = app.model?.botName?.(botID) ?? page.sourceName
    app.nav.sheet({
      title: () => t('weather.about.alert.title', name),
      done: t('weather.common.cancel'),
      render: (handle) => List(
        Card({}, Prose(t('weather.about.alert.message', name))),
        h('div', { class: 'sheet__actions' }, Button({
          label: t('weather.about.alert.clear'),
          kind: 'destructive',
          block: true,
          onclick: () => {
            handle.close()
            Promise.resolve(app.model?.clearReceivedWeather?.({ botID })).catch(() => {})
          },
        }))),
    })
  }

  return safeScreen({
    id: 'radio',
    title: () => WeatherFormatting.sentenceStart(page?.sourceName ?? ''),
    render() {
      const words = copy(app, page)
      const snapshot = page?.snapshot ?? null
      const model = app.model
      const stated = statement()
      const coverage = stated?.coverage ?? null
      const readings = snapshot?.readings ?? []
      const botRows = page?.context?.botRows ?? []
      const cacheTotal = snapshot?.cache?.total ?? 0
      const otherMessages = (app.connection?.otherMessages ?? []).slice(0, 20)
      const channelSlot = page?.context?.channelSlot ?? null
      const lastDatagramAt = page?.context?.session?.lastChannelDatagramAt ?? model?.liveHeardAt ?? null
      const watchedCount = (model?.watchedPlaces?.length ?? 0) + (model?.isMyLocationWatched ? 1 : 0)
      const requests = model?.requestLogSplit ?? { newest: [], all: [] }
      const trafficCount = (model?.trafficEntries?.() ?? []).length

      return List(
        // The places people go from here most, together at the top (alerts, notifications, the
        // stations reporting, what is held), instead of spread down the page under explanations.
        Card({ label: t('web.radio.glance'), key: 'glance' },
          Row({
            key: 'alerts',
            icon: 'exclamationmark.triangle',
            title: t('weather.alertsList.title', page?.sourceName ?? ''),
            value: String((snapshot?.alerts ?? []).length),
            onclick: () => app.nav.push(WeatherAlertsListScreen({ app, page })),
          }),
          // What this phone will tell you about without the tool open (§16); here because
          // everything about it depends on this radio being in range.
          Row({
            key: 'notifications',
            icon: 'bell.fill',
            title: t('weather.notifications.title'),
            value: watchedCount > 0
              ? t('weather.notifications.watchingCount', watchedCount)
              : t('weather.notifications.watchingNone'),
            onclick: () => app.nav.push(WeatherAlertNotificationsScreen({ app, page })),
          }),
          readings.length > 0
            ? Row({
              key: 'stations',
              icon: 'thermometer.medium',
              title: words.stationLink(readings.filter((one) => one.isInFootprint).length, readings.length, page.sourceName),
              onclick: () => { pushPlaceScreen(app, 'WeatherStationsScreen', { app, page }) },
            })
            : null,
          // What is being held, and how much of it is somebody else's question.
          cacheTotal > 0
            ? Row({
              key: 'cache',
              icon: 'tray.full',
              title: t('weather.cache.row', cacheTotal),
              onclick: () => app.nav.push(WeatherCachedScreen({ app, page })),
            })
            : null),

        // The source bot's own statement of its area (spec §10), and nothing weaker: the stations
        // it happens to report this hour describe the weather, not the coverage (§3.1 I-B18).
        Card({
          label: t('weather.covers.header'),
          key: 'covers',
          foot: stated != null
            ? t('weather.covers.stated', page.sourceName, words.time(stated.receivedAt))
            : t('weather.covers.noneFooter'),
        },
        coverage != null
          ? [
            MeshWXCoverage.hasNoAreaFilter(coverage)
              // `n` = 0 and `k` = 0 with neither list cut: no filter at all, which is an answer.
              ? Row({ title: t('weather.covers.area'), value: t('weather.covers.everywhere'), chevron: false })
              : [
                rowIf(t('weather.covers.area'), circle(coverage, words)),
                rowIf(t('weather.covers.zones'), zones(coverage)),
                rowIf(t('weather.covers.offices'), offices(coverage)),
              ],
            coverage.stations > 0
              ? Row({ title: t('weather.covers.stations'), value: t('weather.covers.stationCap', coverage.stations), chevron: false })
              : null,
          ]
          // Not "it covers nothing": until the bot says, the app cannot tell a place outside its
          // area from one it has not been told about (§6).
          : [
            Line(t('weather.covers.none', words.sentenceStart(page?.sourceName ?? ''))),
            h('div', { class: 'ask-block' }, AskButton({
              app, page, title: t('weather.request.askCoverage'), request: WeatherRequest.coverage, showsFootnotes: true,
            })),
          ]),

        // What this phone asked for, newest first, and how each one ended. The only requests
        // anyone can name: the answers were broadcast, and they carry no requester.
        //
        // The newest three only — *"Your requests is way too long of a list"* (owner, 20
        // September 2026) — with the rest one tap away rather than gone.
        Card({ label: t('weather.requests.newest'), key: 'requests', foot: t('weather.requests.footer') },
          requests.newest.length === 0
            ? Line(t('weather.requests.none'))
            : requests.newest.map((entry) => RequestRow({ entry, words, tables: app.tables })),
          requests.all.length > requests.newest.length
            ? Row({
              key: 'all-requests',
              title: t('weather.requests.all', requests.all.length),
              onclick: () => app.nav.push(WeatherRequestsScreen({ app, page })),
            })
            : null),

        // Web only. A browser tab that is the radio's companion is also the thing draining its
        // queue, so a chat or a channel message arrives here and nowhere else. Listed so it is
        // not simply lost; this tool does not answer them.
        otherMessages.length > 0
          ? Card({ label: t('web.radio.other.title'), key: 'other', foot: t('web.radio.other.note') },
            otherMessages.map((message, index) => Row({
              key: `${message.receivedAt}-${index}`,
              icon: message.kind === 'channel' ? 'antenna.radiowaves.left.and.right' : 'paperplane.fill',
              title: message.text,
              subtitle: [message.from, words.time(message.receivedAt)].filter(Boolean).join(' · '),
              chevron: false,
            })))
          : null,

        Card({ label: WeatherChannel.name, key: 'channel' },
          Row({
            title: t('weather.about.channelSlot'),
            chevron: false,
            // Without a radio, or before its channel sync, the table can be empty: that is not
            // "not on your radio".
            value: channelSlot != null
              ? t('weather.about.slot', channelSlot)
              : (model?.isRadioConnected && model?.isChannelSyncDone
                ? t('weather.about.noSlot')
                : t('weather.about.radioOffline')),
          }),
          Row({
            title: t('weather.about.lastMessage'),
            chevron: false,
            value: lastDatagramAt == null ? t('weather.about.noMessage') : words.time(lastDatagramAt),
          }),
          // Everything that went past on the slot, as a chat: *"A way to see all the GRP_DATA
          // traffic on a channel like we do a chat"* (owner, 20 September 2026). It is on this
          // card because it is about the channel, not about this phone's own asking.
          Row({
            key: 'traffic',
            icon: 'antenna.radiowaves.left.and.right',
            title: t('weather.traffic.title'),
            value: trafficCount > 0 ? String(trafficCount) : null,
            onclick: () => app.nav.push(WeatherTrafficScreen({ app, page })),
          })),

        Card({ label: t('weather.about.radios'), key: 'radios', foot: t('weather.about.radiosFooter') },
          // With one radio there is nothing to choose.
          botRows.length >= 2
            ? checkRow({
              key: 'automatic',
              title: t('weather.about.automatic'),
              detail: snapshot?.source != null
                ? t('weather.about.automaticDetail', model?.botName?.(snapshot.source.botID) ?? '')
                : null,
              isSelected: (model?.preferredBotID ?? null) == null,
              onclick: () => { model?.selectBot?.(null); app.nav.refresh() },
            })
            : null,
          botRows.map((row) => checkRow({
            key: String(row.botID),
            title: model?.botName?.(row.botID) ?? '',
            detail: botDetail(row, words),
            isSelected: botRows.length >= 2 && model?.preferredBotID === row.botID,
            disabled: botRows.length < 2,
            onclick: botRows.length < 2 ? null : () => { model?.selectBot?.(row.botID); app.nav.refresh() },
          }))),

        // Four lines: where the request goes, where the answer goes, who keeps it, and what it
        // costs. This is where "answers are public" is said (§11.1). Folded until asked for.
        Card({ label: t('weather.about.howItWorks'), key: 'how' },
          showsHowItWorks
            ? Prose(t('weather.about.line1'), t('weather.about.line2'), t('weather.about.line3'), t('weather.about.line4'))
            : null,
          Row({
            key: 'how-toggle',
            icon: 'info.circle',
            title: showsHowItWorks ? t('web.radio.how.hide') : t('web.radio.how.show'),
            chevron: false,
            trailing: icon(showsHowItWorks ? 'chevron.up' : 'chevron.down', { size: 16 }),
            onclick: () => { showsHowItWorks = !showsHowItWorks; app.nav.refresh() },
          })),

        Card({ key: 'clear', foot: t('weather.about.clearFooter', page?.sourceName ?? '') },
          h('div', { class: 'sheet__actions' }, Button({
            label: t('weather.about.clear'),
            kind: 'destructive',
            block: true,
            disabled: snapshot?.source == null,
            onclick: confirmClear,
          }))),

        // The only ask button on this page is the coverage one, and only while the bot has said
        // nothing: with a statement held, a coverage request has no button here and the bar is
        // what speaks for it.
        PendingBar({ app, requestsOnScreen: coverage == null ? [WeatherRequest.coverage] : [] }),
      )
    },
  })
}

function rowIf(title, value) {
  return value == null ? null : Row({ title, value, chevron: false })
}

function coordinates(centre) {
  return `${centre.latitude.toFixed(3)}, ${centre.longitude.toFixed(3)}`
}
