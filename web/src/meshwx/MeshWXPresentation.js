// Port of MC1Services/Sources/MeshWX/MeshWXPresentation.swift
//
// The pure half of spec §18 and §21: icons, tints, staleness and unit conversions, with no UI
// framework anywhere near them so every rule is a unit test. Nothing here returns a colour or a
// localised string — only a name, a symbol and a number.
//
// Warnings, forecasts, periods and observations arrive here as the *decoded* objects of the
// vectors (PORTING §5), so this module reads `hail_qin`, `high_f`, `wind_dir_deg` and so on.

import { MeshWXSky, MeshWXCompass } from './MeshWXMessage.js';

/**
 * How severe a product is, read off the VTEC significance letter (spec §3): the case name as a
 * string, `"warning"` | `"watch"` | `"advisory"` | `"statement"`.
 *
 * The wire carries no severity field: the letter after the dot is the severity, which is why an
 * app can rank a product it has never heard of.
 */
export const MeshWXSeverity = Object.freeze({
  warning: 'warning',
  watch: 'watch',
  advisory: 'advisory',
  statement: 'statement',

  allCases: Object.freeze(['warning', 'watch', 'advisory', 'statement']),

  /** `"SV.W"` → `"warning"`. `"SPS"` has no significance letter and is a statement. */
  make({ vtec }) {
    const code = String(vtec).toUpperCase();
    const dot = code.lastIndexOf('.');
    let letter;
    if (dot >= 0 && dot + 1 < code.length) {
      letter = code[dot + 1];
    } else if (code === 'SPS') {
      letter = 'S';
    } else {
      return null;
    }
    switch (letter) {
      case 'W': return 'warning';
      case 'A': return 'watch';
      case 'Y': return 'advisory';
      case 'S': return 'statement';
      default: return null;
    }
  },

  /**
   * Sort order for a warning list: the thing that can kill you first (spec §18.2, "sort by
   * severity then expiry").
   */
  rank(severity) {
    switch (severity) {
      case 'warning': return 3;
      case 'watch': return 2;
      case 'advisory': return 1;
      case 'statement': return 0;
      default: return -1;
    }
  },

  /** `<` on two severities: rank order, so `compare(a, b) < 0` means a is less severe. */
  compare(left, right) {
    return MeshWXSeverity.rank(left) - MeshWXSeverity.rank(right);
  },
});

/**
 * A colour *name*, not a colour.
 *
 * The palette belongs to the app's design system (and has to answer to dark mode and to
 * accessibility contrast); this module only knows which NWS convention a product falls under,
 * so it names it and stops. Spec §18.2.
 */
export const MeshWXEventTint = Object.freeze({
  red: 'red',
  yellow: 'yellow',
  orange: 'orange',
  lightOrange: 'lightOrange',
  darkGreen: 'darkGreen',
  green: 'green',
  lightGreen: 'lightGreen',
  orangeRed: 'orangeRed',
  pink: 'pink',
  purple: 'purple',
  lavender: 'lavender',
  tan: 'tan',
  magenta: 'magenta',
  blue: 'blue',
  grey: 'grey',
});

/** The icon and wind accent for a forecast period or an observation. */
export const MeshWXConditionIcon = Object.freeze({
  make({ symbolName, showsWindAccent }) {
    return { symbolName, showsWindAccent };
  },
});

/** Which day and half of it a forecast period covers (spec §7, the `first` byte). */
export const MeshWXPeriodSlot = Object.freeze({
  make({ periodID }) {
    return { dayOffset: Math.floor(periodID / 2), isNight: periodID % 2 === 1 };
  },
});

/**
 * How a forecast's entries are laid out in time, read from the entries themselves:
 * `"periods"` | `"days"` | `"mixed"`.
 *
 * Spec §7 (revision 3): the bot sends whole days, `first` even, each entry with a high and a
 * low; a 127 in either marks that half of the day missing at the edge of the forecast window,
 * not a night. The spec keeps revision 1's form for a later bot — 12-hour periods alternating
 * day and night from `first`, one temperature each — recognisable by an odd `first` or by one
 * temperature always missing. Trusting the period ids renders whole days as "Tonight: high
 * 100°", so the layout is decided by what the entries carry, and a forecast that fits neither
 * shape is shown without hiding any value it holds.
 */
export const MeshWXForecastLayout = Object.freeze({
  /** Spec §7's reserved form: alternating day and night periods, one temperature each. */
  periods: 'periods',
  /**
   * Consecutive days, each with a high and a low, one of which may be missing at the edge of
   * the window.
   */
  days: 'days',
  /** Neither: labels follow the period ids and every temperature present is shown. */
  mixed: 'mixed',

  /**
   * Days when `first` is even and any entry carries both temperatures (a day with one is cut at
   * the window's edge); spec periods when none carries both and every single temperature sits in
   * its slot (a high by day, a low by night); mixed otherwise — an odd `first` with whole days,
   * or singles in the wrong slot, where the period ids and the data disagree and neither can be
   * trusted to label the other.
   */
  make({ of: forecast }) {
    let both = 0;
    let inSlot = 0;
    let outOfSlot = 0;
    forecast.periods.forEach((period, index) => {
      const isNight = (forecast.first_period + index) % 2 === 1;
      const hasHigh = period.high_f != null;
      const hasLow = period.low_f != null;
      if (hasHigh && hasLow) both += 1;
      else if (hasHigh) { if (isNight) outOfSlot += 1; else inSlot += 1; }
      else if (hasLow) { if (isNight) inSlot += 1; else outOfSlot += 1; }
    });
    if (both > 0 && forecast.first_period % 2 === 0) return 'days';
    if (both === 0 && outOfSlot === 0) return 'periods';
    return 'mixed';
  },
});

/** One forecast entry placed in time: `{ index, dayOffset, isNight, period }`. */
export const MeshWXForecastEntry = Object.freeze({
  /**
   * Lays out a forecast's entries per `MeshWXForecastLayout`.
   *
   * For whole days the offset counts entries from `first ÷ 2`, the day the first period id
   * names; for periods it is the period id ÷ 2 and the parity says night (spec §7). `isNight` is
   * null for a whole-day entry.
   */
  entries({ of: forecast }) {
    const layout = MeshWXForecastLayout.make({ of: forecast });
    return forecast.periods.map((period, index) => {
      if (layout === 'days') {
        return {
          index,
          dayOffset: Math.floor(forecast.first_period / 2) + index,
          isNight: null,
          period,
        };
      }
      const id = forecast.first_period + index;
      return { index, dayOffset: Math.floor(id / 2), isNight: id % 2 === 1, period };
    });
  },
});

/**
 * A wind reading broken into its pieces, ready to be formatted:
 * `{ direction, speedMph, gustMph }`.
 *
 * Returns numbers and a compass nibble, never `"WNW 15 gusting 26"`: the unit, the word
 * "gusting" and the order are the app's to localise.
 */
export const MeshWXWindReading = Object.freeze({
  /** `make({ observation })` from a decoded station, `make({ period })` from a decoded period. */
  make({ observation, period }) {
    if (observation != null) {
      const direction = MeshWXCompass.fromDegrees(observation.wind_dir_deg);
      const calm = observation.wind_mph === 0 && direction === MeshWXCompass.north;
      return {
        direction: calm ? null : direction,
        speedMph: observation.wind_mph ?? null,
        gustMph: observation.gust_mph === 0 ? null : observation.gust_mph,
      };
    }
    const direction = MeshWXCompass.fromDegrees(period.wind_dir_deg);
    const calm = period.wind_mph === 0 && direction === MeshWXCompass.north;
    return {
      direction: calm ? null : direction,
      speedMph: period.wind_mph ?? null,
      gustMph: null,
    };
  },

  isCalm(reading) {
    return reading.speedMph === 0 && reading.direction == null;
  },
});

/**
 * What a digest's `feed_health` byte can honestly say (spec §5):
 * `{ kind: 'recent', minutes }`, `{ kind: 'quiet', minutes }` or `{ kind: 'neverReceived' }`.
 *
 * The byte counts minutes since the bot's *home office* last issued anything (EWX for WX-AUS),
 * not the health of the satellite feed: a quiet office passes four hours on a calm night with
 * the feed working. Only "never received" says alerts may not be reaching the bot at all.
 */
export const MeshWXFeedHealth = Object.freeze({
  make({ feedHealth }) {
    if (feedHealth === MeshWXPresentation.feedNeverReceived) return { kind: 'neverReceived' };
    const minutes = MeshWXPresentation.feedHealthMinutes(feedHealth);
    return MeshWXPresentation.isFeedStale({ feedHealth })
      ? { kind: 'quiet', minutes }
      : { kind: 'recent', minutes };
  },

  /**
   * Quiet and never-received both withhold "no alerts": the bot's silence is evidence of calm
   * only while its feed is known to be delivering.
   */
  withholdsCalm(health) {
    return health.kind !== 'recent';
  },
});

export const MeshWXPresentation = Object.freeze({

  // MARK: - Sky and condition icons (spec §18.6)

  /**
   * SF Symbol for an observation's sky, or null for sky 15, which in an observation means the
   * report had no cloud or weather group (spec §6, revision 3): no icon rather than an invented
   * condition.
   */
  observationSymbolName({ for: sky, isNight = false }) {
    return sky === MeshWXSky.other ? null : MeshWXPresentation.symbolName({ for: sky, isNight });
  },

  /**
   * SF Symbol for a sky code (`symbolName({ for: sky, isNight })`) or for a VTEC code
   * (`symbolName({ forVTEC })`).
   *
   * The night variants matter: `sun.max` on an overnight forecast period is the kind of detail
   * that makes an app look wrong at a glance.
   */
  symbolName({ for: sky, forVTEC, isNight = false }) {
    if (forVTEC != null) {
      switch (String(forVTEC).toUpperCase()) {
        case 'TO.W': case 'TO.A': return 'tornado';
        case 'SV.W': case 'SV.A': return 'cloud.bolt';
        case 'FF.W': case 'FA.W': case 'FL.W': return 'water.waves';
        case 'FA.Y': case 'FL.Y': return 'drop';
        case 'HT.Y': case 'EH.W': return 'thermometer.sun';
        case 'WS.W': case 'BZ.W': case 'WW.Y': return 'snowflake';
        case 'HW.W': case 'WI.Y': return 'wind';
        case 'FW.W': return 'flame';
        default: return 'exclamationmark.triangle';
      }
    }
    switch (sky) {
      case MeshWXSky.clear: return isNight ? 'moon.stars' : 'sun.max';
      case MeshWXSky.few: case MeshWXSky.scattered: return isNight ? 'cloud.moon' : 'cloud.sun';
      case MeshWXSky.broken: return 'cloud';
      case MeshWXSky.overcast: return 'cloud.fill';
      case MeshWXSky.fog: return 'cloud.fog';
      case MeshWXSky.smoke: return 'smoke';
      case MeshWXSky.haze: return isNight ? 'moon.haze' : 'sun.haze';
      case MeshWXSky.rain: return 'cloud.rain';
      case MeshWXSky.snow: return 'cloud.snow';
      case MeshWXSky.thunderstorm: return 'cloud.bolt.rain';
      case MeshWXSky.drizzle: return 'cloud.drizzle';
      case MeshWXSky.mist: return 'cloud.fog';
      case MeshWXSky.squall: return 'wind';
      case MeshWXSky.sandOrDust: return 'sun.dust';
      default: return 'cloud';
    }
  },

  /**
   * Icon for a forecast period: the `cond` flags override the base sky code (spec §18.6).
   *
   * Order is by what the flag means for a person's day — a thunderstorm outranks the sleet that
   * may follow it, both outrank fog, and wind is an accent on whatever else is happening rather
   * than a replacement for it.
   */
  icon({ for: period, isNight = false }) {
    let symbol;
    if (period.thunder) {
      symbol = 'cloud.bolt.rain';
    } else if (period.wintry) {
      // `cloud.sleet` is the mixed-precipitation glyph; plain snow keeps `cloud.snow`.
      symbol = period.sky === MeshWXSky.snow ? 'cloud.snow' : 'cloud.sleet';
    } else if (period.fog) {
      symbol = 'cloud.fog';
    } else {
      symbol = MeshWXPresentation.symbolName({ for: period.sky, isNight });
    }
    return { symbolName: symbol, showsWindAccent: period.windy === true };
  },

  // MARK: - Warning colour and icon (spec §18.2)

  /**
   * NWS colour convention for a VTEC code, falling back to the significance letter.
   *
   * Returns `grey` for a code with no recognisable significance: an unknown product is still
   * worth showing, just not worth colouring as an alarm.
   */
  tint({ forVTEC }) {
    switch (String(forVTEC).toUpperCase()) {
      case 'TO.W': return 'red';
      case 'TO.A': return 'yellow';
      case 'SV.W': return 'orange';
      case 'SV.A': return 'lightOrange';
      case 'FF.W': return 'darkGreen';
      case 'FA.W': case 'FL.W': return 'green';
      case 'FA.Y': case 'FL.Y': return 'lightGreen';
      case 'HT.Y': case 'EH.W': return 'orangeRed';
      case 'WS.W': return 'pink';
      case 'BZ.W': return 'purple';
      case 'WW.Y': return 'lavender';
      case 'HW.W': case 'WI.Y': return 'tan';
      case 'FW.W': return 'magenta';
      default: break;
    }
    switch (MeshWXSeverity.make({ vtec: forVTEC })) {
      case 'warning': return 'red';
      case 'watch': return 'yellow';
      case 'advisory': return 'orange';
      case 'statement': return 'grey';
      default: return 'grey';
    }
  },

  // MARK: - Warning tags (spec §18.2)
  //
  // The app renders "Hail 1.00 in"; this module hands over the 1.0. Unit systems, decimal
  // separators and the word for hail are all localisation, and a string built here would be one
  // an app cannot translate.

  /** Hail tag in inches, or null when the product carries no hail tag. */
  hailInches({ quarterInches }) {
    return quarterInches === 0 ? null : quarterInches / 4;
  },

  /** Wind tag in mph, or null when there is none. */
  windTagMph(mph) {
    return mph === 0 ? null : mph;
  },

  /**
   * The tags worth showing for a warning, in the order §18.2 lists them, as
   * `{ kind: 'tornado' | 'floodSource' | 'floodDamage', value }`, `{ kind: 'hail', inches }` and
   * `{ kind: 'wind', mph }`. Each case carries its number; the words are the app's.
   *
   * Non-zero tags only: a warning with no tags should render as a bare headline, not as a row
   * of "none".
   */
  tags({ for: warning }) {
    const out = [];
    if (warning.tornado !== 0) out.push({ kind: 'tornado', value: warning.tornado });
    if (warning.flood_source !== 0) out.push({ kind: 'floodSource', value: warning.flood_source });
    if (warning.flood_damage !== 0 && warning.flood_damage !== 3) {
      out.push({ kind: 'floodDamage', value: warning.flood_damage });
    }
    const inches = MeshWXPresentation.hailInches({ quarterInches: warning.hail_qin });
    if (inches != null) out.push({ kind: 'hail', inches });
    const mph = MeshWXPresentation.windTagMph(warning.wind_mph);
    if (mph != null) out.push({ kind: 'wind', mph });
    return out;
  },

  // MARK: - Staleness (spec §18.3, §5)

  /** Observations older than this are stale: still shown, but with their age. */
  observationStaleAfterMinutes: 120,
  /**
   * **Tunable**: observations older than this are not shown at all. Between the two a reading is
   * the weather as last seen, labelled "5 h old", rather than "No current conditions" (owner
   * decision 2026-10-16). The bot answers `>o` with reports up to the same twelve hours
   * (`OBS_STALE_MAX_AGE_MIN` in meshcore_weather/protocol/v5_builders.py).
   */
  observationShownForMinutes: 720,
  /** Forecasts older than this are stale. */
  forecastStaleAfterMinutes: 720,
  /**
   * `feed_health` above this (4-minute units, so ~4 hours) means the bot's silence stops being
   * evidence of calm weather.
   */
  feedStaleThreshold: 60,
  /** `feed_health` 255: the bot has never received a product from its home office (spec §5). */
  feedNeverReceived: 255,

  /**
   * Unix minutes for a date, the unit every timestamp on the wire uses. `date` is milliseconds
   * since the epoch (PORTING §3).
   */
  unixMinutes({ for: date }) {
    const seconds = date / 1000;
    if (!(seconds > 0)) return 0;
    return Math.min(Math.floor(seconds / 60), 0xffff_ffff);
  },

  isObservationStale({ timestampMinutes, now }) {
    return now > timestampMinutes + MeshWXPresentation.observationStaleAfterMinutes;
  },

  isObservationTooOld({ timestampMinutes, now }) {
    return now > timestampMinutes + MeshWXPresentation.observationShownForMinutes;
  },

  isForecastStale({ issuedMinutes, now }) {
    return now > issuedMinutes + MeshWXPresentation.forecastStaleAfterMinutes;
  },

  /** Quiet or never received: either way silence is no evidence of calm (`MeshWXFeedHealth`). */
  isFeedStale({ feedHealth }) {
    return feedHealth > MeshWXPresentation.feedStaleThreshold;
  },

  /**
   * `feed_health` in minutes. 255 is capped and means "17 hours or more, or unknown", so it is
   * reported as its floor rather than as a precise 1020.
   */
  feedHealthMinutes(feedHealth) {
    return feedHealth * 4;
  },

  /** Minutes until a warning expires, or null once it has passed. */
  minutesUntilExpiry({ expiresMinutes, now }) {
    return expiresMinutes > now ? expiresMinutes - now : null;
  },

  // MARK: - Forecast periods (spec §7)

  /** Which day and half of it the `n`th period of a forecast covers. */
  slot({ forecast, periodOffset }) {
    return MeshWXPeriodSlot.make({ periodID: (forecast.first_period + periodOffset) & 0xff });
  },

  // MARK: - Units

  /**
   * Wire byte → inches of mercury. Built from integers so the result is exactly the two-decimal
   * value, matching the decoder.
   */
  inchesOfMercury({ fromRawPressure }) {
    return fromRawPressure === 255 ? null : (2900 + fromRawPressure) / 100;
  },

  /** Inches of mercury → millibars (hPa), for the rest of the world. */
  millibars({ fromInchesOfMercury }) {
    return fromInchesOfMercury * 33.863886666667;
  },

  celsius({ fromFahrenheit }) {
    return ((fromFahrenheit - 32) * 5) / 9;
  },

  kilometres({ fromMiles }) {
    return fromMiles * 1.609344;
  },

  kilometresPerHour({ fromMilesPerHour }) {
    return fromMilesPerHour * 1.609344;
  },
});
