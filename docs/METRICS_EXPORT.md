# Weather history export (InfluxDB / Prometheus / Grafana)

The bot can hand the weather readings it collects to your own time-series
database, so you can keep a history and graph it in Grafana. **Both outputs
are off by default**; nothing leaves the bot until you set one of them up.

What is exported: the newest METAR observation per station from the EMWIN
feed (the same decoder the mesh replies use) — temperature, dew point, wind
direction, wind speed, gust, visibility and altimeter pressure — plus a few
bot gauges (radio connected, EMWIN products held, InfluxDB points sent). A
value a report does not carry is left out, never sent as zero.

This runs in the Python bot (`meshcore_weather`), not the browser client.

## Settings

All are environment variables (or `.env` / `deploy/pi.env.example` lines):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCW_METRICS_INFLUX_URL` | empty (off) | Full InfluxDB write URL. v2: `http://influx.lan:8086/api/v2/write?org=home&bucket=weather`. v1: `http://influx.lan:8086/write?db=weather`. `precision=s` is added if missing. |
| `MCW_METRICS_INFLUX_TOKEN` | empty | Sent as `Authorization: Token <token>`. A value with a space (`Bearer x`, `Basic x`) is sent as written. |
| `MCW_METRICS_INTERVAL_S` | `60` | How often new observations are pushed (minimum 10). |
| `MCW_METRICS_PROMETHEUS_ENABLED` | `false` | Serve `/metrics` for Prometheus. |
| `MCW_METRICS_PROMETHEUS_HOST` | `127.0.0.1` | Bind address. Localhost only unless you change it on purpose. |
| `MCW_METRICS_PROMETHEUS_PORT` | `9137` | Port for `/metrics`. |
| `MCW_METRICS_STATIONS` | empty | ICAO ids to export, e.g. `KAUS,KSAT`. Empty = every station in the feed with a fresh report. |
| `MCW_METRICS_MAX_AGE_MIN` | `180` | Older reports are not exported. |
| `MCW_METRICS_MAX_STATIONS` | `300` | Cap when no station list is set (the national feed has thousands). |

Setting a station list is recommended: it keeps the series count small.

## InfluxDB

Each push writes one line per station whose observation is newer than the
last one sent:

```
wxguard_weather,station=KAUS dewpoint_f=30.0,pressure_inhg=29.98,temp_f=70.0,wind_speed_mph=14.0 1763058180
```

The timestamp is when the station took the observation, so the history is the
stations' real history and a re-sent point simply overwrites itself. A failed
push is logged and retried on the next round.

Flux example for a Grafana panel:

```flux
from(bucket: "weather")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "wxguard_weather" and r._field == "temp_f")
```

## Prometheus

```yaml
scrape_configs:
  - job_name: wxguard
    scrape_interval: 60s
    static_configs:
      - targets: ["127.0.0.1:9137"]
```

Metric names: `wxguard_weather_<field>{station="KAUS"}` for each field above,
`wxguard_weather_observed_timestamp_seconds`, `wxguard_radio_connected`,
`wxguard_store_products`, and (with InfluxDB on) `wxguard_influx_points_sent`
and `wxguard_influx_last_success_timestamp_seconds`.

Only `GET`/`HEAD /metrics` is answered; there is no other page and no write
path. If Prometheus runs on another machine, prefer an SSH tunnel or a local
Prometheus agent over binding `0.0.0.0`.

## Grafana

Import `deploy/grafana/wxguard-weather-dashboard.json` (Dashboards → New →
Import) and pick your Prometheus data source. It has a station picker, stat
tiles for radio and feed health, and panels for temperature/dew point,
wind/gust, pressure, visibility and report age. For InfluxDB, copy the
panels and swap in Flux queries like the one above.
