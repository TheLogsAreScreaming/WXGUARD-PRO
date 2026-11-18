// Port of MC1Services/Tests/MeshWXTests/MeshWXPresentationTests.swift
//
// The rendering rules of spec §18, kept testable by never returning a colour or a localised
// string — only a name, a symbol and a number.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshWXPresentation,
  MeshWXSeverity,
  MeshWXFeedHealth,
  MeshWXPeriodSlot,
  MeshWXWindReading,
  MeshWXForecastLayout,
  MeshWXForecastEntry,
  MeshWXForecastPeriod,
  MeshWXForecast,
  MeshWXStationObservation,
  MeshWXWarning,
  MeshWXSky,
  MeshWXCompass,
} from '../src/meshwx/index.js';

const period = (fields) => MeshWXForecastPeriod.make(fields);
const forecast = (fields) => MeshWXForecast.make(fields);

describe('MeshWX presentation', () => {
  test('skySymbolsHaveDayAndNightVariants', () => {
    assert.equal(MeshWXPresentation.symbolName({ for: MeshWXSky.clear }), 'sun.max');
    assert.equal(
      MeshWXPresentation.symbolName({ for: MeshWXSky.clear, isNight: true }), 'moon.stars',
    );
    assert.equal(MeshWXPresentation.symbolName({ for: MeshWXSky.few }), 'cloud.sun');
    assert.equal(
      MeshWXPresentation.symbolName({ for: MeshWXSky.few, isNight: true }), 'cloud.moon',
    );
    // Cloud decks and precipitation look the same at night.
    assert.equal(MeshWXPresentation.symbolName({ for: MeshWXSky.overcast }), 'cloud.fill');
    assert.equal(
      MeshWXPresentation.symbolName({ for: MeshWXSky.overcast, isNight: true }), 'cloud.fill',
    );
    assert.equal(
      MeshWXPresentation.symbolName({ for: MeshWXSky.thunderstorm }), 'cloud.bolt.rain',
    );
  });

  test('forecastFlagsOverrideTheBaseSkyIcon', () => {
    const clearNight = period({ sky: MeshWXSky.clear });
    assert.equal(
      MeshWXPresentation.icon({ for: clearNight, isNight: true }).symbolName, 'moon.stars',
    );

    // Thunder wins over a "few clouds" sky code.
    const storm = period({ sky: MeshWXSky.few, thunder: true });
    assert.equal(MeshWXPresentation.icon({ for: storm }).symbolName, 'cloud.bolt.rain');

    const sleet = period({ sky: MeshWXSky.rain, wintry: true });
    assert.equal(MeshWXPresentation.icon({ for: sleet }).symbolName, 'cloud.sleet');
    const snow = period({ sky: MeshWXSky.snow, wintry: true });
    assert.equal(MeshWXPresentation.icon({ for: snow }).symbolName, 'cloud.snow');

    const foggy = period({ sky: MeshWXSky.broken, fog: true });
    assert.equal(MeshWXPresentation.icon({ for: foggy }).symbolName, 'cloud.fog');

    // Wind is an accent, not a replacement: a windy rainy day still shows rain.
    const windyRain = period({ sky: MeshWXSky.rain, windy: true });
    const icon = MeshWXPresentation.icon({ for: windyRain });
    assert.equal(icon.symbolName, 'cloud.rain');
    assert.ok(icon.showsWindAccent);
    assert.ok(!MeshWXPresentation.icon({ for: period({ sky: MeshWXSky.rain }) }).showsWindAccent);
  });

  test('eventTintsFollowTheNWSTable', () => {
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'TO.W' }), 'red');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'TO.A' }), 'yellow');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'SV.W' }), 'orange');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'SV.A' }), 'lightOrange');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'FF.W' }), 'darkGreen');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'FA.W' }), 'green');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'FL.Y' }), 'lightGreen');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'EH.W' }), 'orangeRed');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'WS.W' }), 'pink');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'BZ.W' }), 'purple');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'WW.Y' }), 'lavender');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'HW.W' }), 'tan');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'FW.W' }), 'magenta');
  });

  test('unlistedEventsFallBackToSignificance', () => {
    // Nothing in §18.2 covers a dust storm warning or a rip current statement; the letter after
    // the dot still ranks and colours them.
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'DS.W' }), 'red');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'SQ.A' }), 'yellow');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'RP.S' }), 'grey');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'SPS' }), 'grey');
    assert.equal(MeshWXPresentation.tint({ forVTEC: 'nonsense' }), 'grey');
    assert.equal(
      MeshWXPresentation.symbolName({ forVTEC: 'DS.W' }), 'exclamationmark.triangle',
    );
    assert.equal(MeshWXPresentation.symbolName({ forVTEC: 'TO.W' }), 'tornado');
    assert.equal(MeshWXPresentation.symbolName({ forVTEC: 'FW.W' }), 'flame');
  });

  test('severityRanksWarningsFirst', () => {
    assert.equal(MeshWXSeverity.make({ vtec: 'SV.W' }), MeshWXSeverity.warning);
    assert.equal(MeshWXSeverity.make({ vtec: 'SV.A' }), MeshWXSeverity.watch);
    assert.equal(MeshWXSeverity.make({ vtec: 'HT.Y' }), MeshWXSeverity.advisory);
    assert.equal(MeshWXSeverity.make({ vtec: 'SPS' }), MeshWXSeverity.statement);
    assert.equal(MeshWXSeverity.make({ vtec: 'garbage' }), null);
    assert.ok(MeshWXSeverity.compare(MeshWXSeverity.warning, MeshWXSeverity.watch) > 0);
    assert.ok(MeshWXSeverity.compare(MeshWXSeverity.advisory, MeshWXSeverity.statement) > 0);
  });

  test('tagsAreReturnedAsNumbersNotSentences', () => {
    // §18.2 renders "Hail 1.00 in" and "Wind 60 mph"; the module hands over 1.0 and 60 so the
    // app can translate the words and choose the unit.
    assert.equal(MeshWXPresentation.hailInches({ quarterInches: 4 }), 1.0);
    assert.equal(MeshWXPresentation.hailInches({ quarterInches: 7 }), 1.75);
    assert.equal(MeshWXPresentation.hailInches({ quarterInches: 0 }), null);
    assert.equal(MeshWXPresentation.windTagMph(60), 60);
    assert.equal(MeshWXPresentation.windTagMph(0), null);

    const warning = MeshWXWarning.make({
      identity: { event: 3, office: 35, etn: 42 },
      expiresMinutes: 29_823_945,
      tornado: 2, // radar indicated
      floodDamage: 1, // considerable
      hailQuarterInches: 4,
      windMph: 60,
    });
    assert.equal(MeshWXWarning.hailInches(warning), 1.0);
    assert.deepStrictEqual(MeshWXPresentation.tags({ for: warning }), [
      { kind: 'tornado', value: 2 },
      { kind: 'floodDamage', value: 1 },
      { kind: 'hail', inches: 1.0 },
      { kind: 'wind', mph: 60 },
    ]);

    const quiet = MeshWXWarning.make({
      identity: { event: 24, office: 35, etn: 7 }, expiresMinutes: 0,
    });
    assert.equal(MeshWXPresentation.tags({ for: quiet }).length, 0);
  });

  test('stalenessThresholdsMatchTheSpec', () => {
    const issued = 1_000_000;
    // Two hours for an observation.
    assert.ok(!MeshWXPresentation.isObservationStale({
      timestampMinutes: issued, now: issued + 120,
    }));
    assert.ok(MeshWXPresentation.isObservationStale({
      timestampMinutes: issued, now: issued + 121,
    }));
    // Twelve for a forecast.
    assert.ok(!MeshWXPresentation.isForecastStale({ issuedMinutes: issued, now: issued + 720 }));
    assert.ok(MeshWXPresentation.isForecastStale({ issuedMinutes: issued, now: issued + 721 }));
    // feed_health is in units of four minutes; 60 is four hours.
    assert.ok(!MeshWXPresentation.isFeedStale({ feedHealth: 60 }));
    assert.ok(MeshWXPresentation.isFeedStale({ feedHealth: 61 }));
    assert.equal(MeshWXPresentation.feedHealthMinutes(7), 28);
    assert.equal(MeshWXPresentation.feedHealthMinutes(255), 1020);
  });

  /** Spec §6 (revision 3): sky 15 is a report with no cloud or weather group. */
  test('anObservationWithNoSkyGroupHasNoIcon', () => {
    assert.equal(MeshWXPresentation.observationSymbolName({ for: MeshWXSky.other }), null);
    assert.equal(
      MeshWXPresentation.observationSymbolName({ for: MeshWXSky.clear, isNight: true }),
      'moon.stars',
    );
  });

  /** Spec §5: the byte is one office's quiet, and only 255 says nothing ever arrived. */
  test('feedHealthSplitsAQuietOfficeFromAFeedThatNeverDelivered', () => {
    assert.deepStrictEqual(
      MeshWXFeedHealth.make({ feedHealth: 0 }), { kind: 'recent', minutes: 0 },
    );
    assert.deepStrictEqual(
      MeshWXFeedHealth.make({ feedHealth: 60 }), { kind: 'recent', minutes: 240 },
    );
    assert.deepStrictEqual(
      MeshWXFeedHealth.make({ feedHealth: 61 }), { kind: 'quiet', minutes: 244 },
    );
    assert.deepStrictEqual(
      MeshWXFeedHealth.make({ feedHealth: 254 }), { kind: 'quiet', minutes: 1016 },
    );
    assert.deepStrictEqual(
      MeshWXFeedHealth.make({ feedHealth: 255 }), { kind: 'neverReceived' },
    );
    assert.ok(!MeshWXFeedHealth.withholdsCalm({ kind: 'recent', minutes: 240 }));
    assert.ok(MeshWXFeedHealth.withholdsCalm({ kind: 'quiet', minutes: 244 }));
    assert.ok(MeshWXFeedHealth.withholdsCalm({ kind: 'neverReceived' }));
  });

  test('expiryCountsDownAndThenStops', () => {
    assert.equal(MeshWXPresentation.minutesUntilExpiry({ expiresMinutes: 1042, now: 1000 }), 42);
    assert.equal(MeshWXPresentation.minutesUntilExpiry({ expiresMinutes: 1000, now: 1000 }), null);
    assert.equal(MeshWXPresentation.minutesUntilExpiry({ expiresMinutes: 999, now: 1000 }), null);
  });

  test('periodIDsMapToDayAndNight', () => {
    // 0 today, 1 tonight, 2 tomorrow, 3 tomorrow night (spec §7).
    assert.deepStrictEqual(
      MeshWXPeriodSlot.make({ periodID: 0 }), MeshWXPeriodSlot.make({ periodID: 0 }),
    );
    assert.ok(!MeshWXPeriodSlot.make({ periodID: 0 }).isNight);
    assert.equal(MeshWXPeriodSlot.make({ periodID: 0 }).dayOffset, 0);
    assert.ok(MeshWXPeriodSlot.make({ periodID: 1 }).isNight);
    assert.equal(MeshWXPeriodSlot.make({ periodID: 1 }).dayOffset, 0);
    assert.equal(MeshWXPeriodSlot.make({ periodID: 2 }).dayOffset, 1);
    assert.equal(MeshWXPeriodSlot.make({ periodID: 7 }).dayOffset, 3);
    assert.ok(MeshWXPeriodSlot.make({ periodID: 7 }).isNight);

    // The kit's forecast vector starts at period 1 (tonight), so its fourth entry is the day
    // after tomorrow's daytime.
    const kit = forecast({
      pointIndex: 102, issuedMinutes: 29_823_780, firstPeriod: 1, periods: [],
    });
    assert.ok(MeshWXPresentation.slot({ forecast: kit, periodOffset: 0 }).isNight);
    assert.equal(MeshWXPresentation.slot({ forecast: kit, periodOffset: 3 }).dayOffset, 2);
    assert.ok(!MeshWXPresentation.slot({ forecast: kit, periodOffset: 3 }).isNight);
  });

  test('windReadingsSeparateCalmFromUnknown', () => {
    // Direction 0 with speed 0 is calm (spec §6), so no arrow should be drawn.
    const calm = MeshWXStationObservation.make({
      station: 860, wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.north), wind_mph: 0,
    });
    const calmReading = MeshWXWindReading.make({ observation: calm });
    assert.equal(calmReading.direction, null);
    assert.ok(MeshWXWindReading.isCalm(calmReading));

    const breezy = MeshWXStationObservation.make({
      station: 202,
      wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.southSouthEast),
      wind_mph: 12,
      gust_mph: 21,
    });
    const reading = MeshWXWindReading.make({ observation: breezy });
    assert.equal(reading.direction, MeshWXCompass.southSouthEast);
    assert.equal(reading.speedMph, 12);
    assert.equal(reading.gustMph, 21);
    assert.ok(!MeshWXWindReading.isCalm(reading));

    // No speed at all is not calm — it is unknown.
    const silent = MeshWXStationObservation.make({
      station: 976, wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.westNorthWest),
    });
    assert.equal(MeshWXWindReading.make({ observation: silent }).speedMph, null);
    assert.ok(!MeshWXWindReading.isCalm(MeshWXWindReading.make({ observation: silent })));

    // Forecast periods never carry a gust.
    assert.equal(MeshWXWindReading.make({
      period: period({
        wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.south), wind_mph: 10,
      }),
    }).gustMph, null);
  });

  test('pressureConvertsBothWays', () => {
    assert.equal(MeshWXPresentation.inchesOfMercury({ fromRawPressure: 92 }), 29.92);
    assert.equal(MeshWXPresentation.inchesOfMercury({ fromRawPressure: 0 }), 29.0);
    assert.equal(MeshWXPresentation.inchesOfMercury({ fromRawPressure: 255 }), null);
    const millibars = MeshWXPresentation.millibars({ fromInchesOfMercury: 29.92 });
    assert.ok(Math.abs(millibars - 1013.2) < 0.1);
    assert.ok(Math.abs(MeshWXPresentation.celsius({ fromFahrenheit: 88 }) - 31.1) < 0.05);
    assert.ok(Math.abs(MeshWXPresentation.kilometres({ fromMiles: 10 }) - 16.09) < 0.01);
  });

  test('unixMinutesMatchTheWire', () => {
    // The kit's severe thunderstorm vector expires at 29 823 945 minutes. PORTING §3: a Date is
    // milliseconds since the epoch.
    assert.equal(MeshWXPresentation.unixMinutes({ for: 29_823_945 * 60 * 1000 }), 29_823_945);
    assert.equal(MeshWXPresentation.unixMinutes({ for: -10 * 1000 }), 0);
  });
});

/** The forecast shape is read from the entries, not from spec §7's period ids alone. */
describe('MeshWX forecast layout', () => {
  /** The kit vector: first period 1 (tonight), alternating single temperatures. */
  const specForecast = forecast({
    pointIndex: 102,
    issuedMinutes: 29_823_780,
    firstPeriod: 1,
    periods: [
      period({ low_f: 73, pop_pct: 20, sky: MeshWXSky.scattered }),
      period({ high_f: 93, pop_pct: 40, sky: MeshWXSky.broken }),
      period({ low_f: 72, pop_pct: 30, sky: MeshWXSky.broken }),
      period({ high_f: 90, pop_pct: 60, sky: MeshWXSky.rain }),
    ],
  });

  /** The live WX-AUS forecast for Austin Camp Mabry on 2026-09-14, as the phone held it. */
  const liveForecast = forecast({
    pointIndex: 103,
    issuedMinutes: 29_823_380,
    firstPeriod: 0,
    periods: [[102, 77], [100, 78], [98, 75], [97, 73], [98, 74], [99, 76], [96, 81]].map(
      ([high, low]) => period({ high_f: high, low_f: low, sky: MeshWXSky.scattered }),
    ),
  });

  test('theKitVectorIsSpecPeriods', () => {
    assert.equal(MeshWXForecastLayout.make({ of: specForecast }), MeshWXForecastLayout.periods);
    const entries = MeshWXForecastEntry.entries({ of: specForecast });
    assert.deepStrictEqual(entries.map((e) => e.dayOffset), [0, 1, 1, 2]);
    assert.deepStrictEqual(entries.map((e) => e.isNight), [true, false, true, false]);
  });

  test('theLiveBotSendsWholeDays', () => {
    assert.equal(MeshWXForecastLayout.make({ of: liveForecast }), MeshWXForecastLayout.days);
    const entries = MeshWXForecastEntry.entries({ of: liveForecast });
    assert.deepStrictEqual(entries.map((e) => e.dayOffset), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(entries.every((e) => e.isNight === null));
    assert.equal(entries[1].period.high_f, 100);
    assert.equal(entries[1].period.low_f, 78);
  });

  /**
   * Spec §7 (revision 3): a 127 at the edge of the forecast window is half a day missing, not a
   * night.
   */
  test('aDayMissingOneTemperatureIsStillADay', () => {
    const edge = forecast({
      pointIndex: 1,
      issuedMinutes: 0,
      firstPeriod: 0,
      periods: [period({ high_f: 90, low_f: 70 }), period({ low_f: 68 })],
    });
    assert.equal(MeshWXForecastLayout.make({ of: edge }), MeshWXForecastLayout.days);
    const entries = MeshWXForecastEntry.entries({ of: edge });
    assert.deepStrictEqual(entries.map((e) => e.isNight), [null, null]);
    assert.deepStrictEqual(entries.map((e) => e.dayOffset), [0, 1]);
  });

  /**
   * Spec §7 (revision 3): `first` counts half-days from the issue date, and an evening issue
   * with no usable rest of today sends 2, so its first entry is tomorrow.
   */
  test('anEveningIssueStartsTomorrow', () => {
    const evening = forecast({
      pointIndex: 103,
      issuedMinutes: 29_823_380,
      firstPeriod: 2,
      periods: liveForecast.periods,
    });
    assert.equal(MeshWXForecastLayout.make({ of: evening }), MeshWXForecastLayout.days);
    assert.deepStrictEqual(
      MeshWXForecastEntry.entries({ of: evening }).map((e) => e.dayOffset),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  test('wholeDaysFromAnOddFirstAreMixedAndHideNothing', () => {
    const mixed = forecast({
      pointIndex: 1,
      issuedMinutes: 0,
      firstPeriod: 1,
      periods: [period({ high_f: 90, low_f: 70 }), period({ high_f: 91 })],
    });
    assert.equal(MeshWXForecastLayout.make({ of: mixed }), MeshWXForecastLayout.mixed);
    const entries = MeshWXForecastEntry.entries({ of: mixed });
    assert.deepStrictEqual(entries.map((e) => e.isNight), [true, false]);
    assert.equal(entries[0].period.high_f, 90);
    assert.equal(entries[0].period.low_f, 70);
  });

  test('singleTemperaturesInTheWrongSlotAreMixed', () => {
    // Period 0 is a day, but the entry carries only a low.
    const wrongSlot = forecast({
      pointIndex: 1,
      issuedMinutes: 0,
      firstPeriod: 0,
      periods: [period({ low_f: 70 }), period({ high_f: 90 })],
    });
    assert.equal(MeshWXForecastLayout.make({ of: wrongSlot }), MeshWXForecastLayout.mixed);
  });

  test('aForecastWithNoTemperaturesFallsBackToSpecPeriods', () => {
    const bare = forecast({
      pointIndex: 1,
      issuedMinutes: 0,
      firstPeriod: 2,
      periods: [period({ pop_pct: 10 }), period({ pop_pct: 20 })],
    });
    assert.equal(MeshWXForecastLayout.make({ of: bare }), MeshWXForecastLayout.periods);
    assert.deepStrictEqual(
      MeshWXForecastEntry.entries({ of: bare }).map((e) => e.dayOffset), [1, 1],
    );
  });
});
