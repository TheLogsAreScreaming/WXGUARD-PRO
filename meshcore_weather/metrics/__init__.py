"""Weather history export: InfluxDB line protocol push and a Prometheus
`/metrics` page. Both are off unless configured (see docs/METRICS_EXPORT.md).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import timedelta

from meshcore_weather.metrics.influx import InfluxPusher
from meshcore_weather.metrics.prometheus import MetricsServer, render
from meshcore_weather.metrics.readings import Reading, latest_readings, parse_station_list

logger = logging.getLogger(__name__)

__all__ = ["MetricsExporter", "Reading", "latest_readings", "render"]


class MetricsExporter:
    """Collects readings from the store every `interval_s` and hands them to
    whichever outputs are configured. The /metrics page reads the store when
    it is scraped, so it is never staler than the feed."""

    def __init__(self, store, *, influx_url: str = "", influx_token: str = "",
                 prometheus_enabled: bool = False, prometheus_host: str = "127.0.0.1",
                 prometheus_port: int = 9137, stations: str = "", interval_s: int = 60,
                 max_age_min: int = 180, max_stations: int = 300,
                 radio_connected: Callable[[], bool] | None = None, influx_client=None):
        self._store = store
        self._stations = parse_station_list(stations)
        self._max_age = timedelta(minutes=max_age_min)
        self._max_stations = max_stations
        self._interval = max(10, int(interval_s))
        self._radio_connected = radio_connected
        self.influx = InfluxPusher(influx_url, influx_token, client=influx_client) if influx_url else None
        self.server = (MetricsServer(self.page, prometheus_host, prometheus_port)
                       if prometheus_enabled else None)
        self._task: asyncio.Task | None = None
        self.last_push_ok: float = 0.0

    @classmethod
    def from_settings(cls, store, settings, radio_connected=None) -> MetricsExporter | None:
        """The exporter the settings ask for, or None when both outputs are off."""
        if not settings.metrics_influx_url and not settings.metrics_prometheus_enabled:
            return None
        return cls(
            store,
            influx_url=settings.metrics_influx_url,
            influx_token=settings.metrics_influx_token,
            prometheus_enabled=settings.metrics_prometheus_enabled,
            prometheus_host=settings.metrics_prometheus_host,
            prometheus_port=settings.metrics_prometheus_port,
            stations=settings.metrics_stations,
            interval_s=settings.metrics_interval_s,
            max_age_min=settings.metrics_max_age_min,
            max_stations=settings.metrics_max_stations,
            radio_connected=radio_connected,
        )

    def readings(self) -> list[Reading]:
        return latest_readings(self._store, self._stations, self._max_age, self._max_stations)

    def gauges(self) -> dict[str, tuple[float, str]]:
        g: dict[str, tuple[float, str]] = {
            "wxguard_store_products": (float(len(self._store._products)),
                                       "EMWIN products the bot holds."),
        }
        if self._radio_connected is not None:
            try:
                up = 1.0 if self._radio_connected() else 0.0
            except Exception:
                up = 0.0
            g["wxguard_radio_connected"] = (up, "1 when the MeshCore radio is connected.")
        if self.influx is not None:
            g["wxguard_influx_points_sent"] = (float(self.influx.points_sent),
                                               "Points pushed to InfluxDB since start.")
            g["wxguard_influx_last_success_timestamp_seconds"] = (
                self.last_push_ok, "When the last InfluxDB push succeeded (Unix time, 0 = never).")
        return g

    def page(self) -> str:
        return render(self.readings(), self.gauges())

    async def push_once(self) -> int:
        if self.influx is None:
            return 0
        sent = await self.influx.push(self.readings())
        if not self.influx.last_error:
            self.last_push_ok = time.time()
        return sent

    async def start(self) -> None:
        if self.server is not None:
            await self.server.start()
        if self.influx is not None:
            logger.info("InfluxDB export every %ds to %s", self._interval, self.influx.url.split("?", 1)[0])
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            try:
                await self.push_once()
            except Exception:
                logger.exception("metrics export round failed (non-fatal)")
            await asyncio.sleep(self._interval)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self.server is not None:
            await self.server.stop()
