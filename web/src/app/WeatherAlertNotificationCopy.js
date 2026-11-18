// Port of MC1/Views/Tools/Weather/WeatherAlertNotificationCopy.swift (docs/PORTING.md).

import { t } from '../l10n.js'
import { MeshWXTables } from '../meshwx/index.js'
import { WeatherAlertNotificationContent, WeatherAlertNotificationSubject } from '../weather/index.js'
import { WeatherFormatting } from './WeatherFormatting.js'

/**
 * The words of an alert notification, from the app's own string tables (docs/MESHWX_UI.md §16).
 *
 * The evaluator runs in the weather layer, which words notifications through
 * `WeatherAlertNotificationCopyRegistry` — the same boundary the Swift draws. The weather layer
 * ships `WeatherAlertDefaultCopy` and stands in until `install` has run; this is the app's own,
 * and it is the one the Swift phone shows.
 *
 * Two things it does that the layer's fallback does not, both from the Swift:
 *
 * - The place keeps its state. `WeatherFormatting.placeName` trims and nothing else, because one
 *   label per place is the rule (docs/MESHWX_UI.md §3.1 U-12); the fallback cuts "Austin, TX"
 *   down to "Austin".
 * - The title is the event's **long** name (`WeatherFormatting.eventName`), falling back to the
 *   short label; the fallback only ever uses the short label.
 */
export const WeatherAlertNotificationCopyImpl = Object.freeze({
  /** The app's copy with the runtime's own locale and time zone. */
  make({ locale, timeZone } = {}) {
    return {
      get myLocationLabel() {
        return t('weather.notifications.myLocationLabel')
      },

      content(subject, { tables = MeshWXTables.shared } = {}) {
        const place = WeatherFormatting.placeName(subject.placeLabel)
        const parts = []
        if (subject.placement.kind === 'near') {
          parts.push(
            t(
              'weather.notifications.near',
              WeatherFormatting.distance(subject.placement.kilometres, {
                direction: subject.placement.direction,
              }),
              place,
            ),
          )
        } else {
          parts.push(place)
        }
        // When it applies, without the countdown (spec §18.2, revision 12): "40 min left" in a
        // notification centre is stale the moment it is read, and a watch not yet in effect says
        // "from Wed 7:00 PM until Fri 7:00 PM" rather than looking as if it were in force.
        parts.push(
          WeatherFormatting.alertWindow({
            beginsAt: subject.beginsAt ?? null,
            expiresAt: WeatherAlertNotificationSubject.expiresAt(subject),
            now: subject.now,
            timeZone,
            locale,
            countdown: false,
          }),
        )
        // One tag, the one the warning is being called for: a lock screen is not the place for the
        // whole line the alerts card carries.
        const tag = WeatherFormatting.tagTexts({ for: subject.warning, locale })[0]
        if (tag != null) parts.push(tag)
        let body = parts.join(' · ')
        if (subject.isLate) body += `\n${t('weather.notifications.late')}`
        return WeatherAlertNotificationContent.make({
          title: WeatherFormatting.eventName(subject.warning.event, { tables }),
          subtitle:
            subject.botName != null
              ? t('weather.alerts.source', subject.botName)
              : t('weather.alerts.sourceGeneric'),
          body,
        })
      },
    }
  },
})

/** The copy the app installs at boot, with the runtime's own locale and time zone. */
export const WeatherAlertNotificationCopy = WeatherAlertNotificationCopyImpl.make()
