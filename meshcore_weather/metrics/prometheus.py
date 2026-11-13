"""A Prometheus text-format `/metrics` page, served on localhost.

The server is a few lines of asyncio: GET /metrics returns the page, every
other path 404s, and nothing but GET/HEAD is answered. It binds 127.0.0.1 by
default; binding anything else is the operator's explicit choice.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from meshcore_weather.metrics.readings import FIELDS, Reading

logger = logging.getLogger(__name__)

PREFIX = "wxguard_weather_"


def _label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _num(v: float) -> str:
    return repr(float(v))


def render(readings: list[Reading], gauges: dict[str, tuple[float, str]] | None = None) -> str:
    """The exposition text. `gauges` adds bot-level numbers:
    name -> (value, help text)."""
    out: list[str] = []
    for field, unit in FIELDS.items():
        rows = [r for r in readings if field in r.values]
        if not rows:
            continue
        name = PREFIX + field
        out.append(f"# HELP {name} Latest METAR {field.replace('_', ' ')} ({unit}).")
        out.append(f"# TYPE {name} gauge")
        for r in rows:
            out.append(f'{name}{{station="{_label(r.station)}"}} {_num(r.values[field])}')
    if readings:
        name = PREFIX + "observed_timestamp_seconds"
        out.append(f"# HELP {name} When the station's latest observation was taken (Unix time).")
        out.append(f"# TYPE {name} gauge")
        for r in readings:
            out.append(f'{name}{{station="{_label(r.station)}"}} {int(r.observed_at.timestamp())}')
    for name, (value, help_text) in sorted((gauges or {}).items()):
        out.append(f"# HELP {name} {help_text}")
        out.append(f"# TYPE {name} gauge")
        out.append(f"{name} {_num(value)}")
    return "\n".join(out) + "\n"


class MetricsServer:
    """Serves `page()` at /metrics."""

    def __init__(self, page: Callable[[], str], host: str = "127.0.0.1", port: int = 9137):
        self._page = page
        self.host = host
        self.port = port
        self._server: asyncio.base_events.Server | None = None

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, self.host, self.port)
        sock = self._server.sockets[0] if self._server.sockets else None
        if sock is not None:
            self.port = sock.getsockname()[1]
        logger.info("Prometheus metrics on http://%s:%d/metrics", self.host, self.port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), timeout=5)
            # Drain the headers; we need none of them.
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5)
                if not line or line in (b"\r\n", b"\n"):
                    break
            parts = request.decode("latin-1").split()
            method = parts[0] if parts else ""
            path = parts[1].split("?", 1)[0] if len(parts) > 1 else ""
            if method not in ("GET", "HEAD"):
                status, body, ctype = "405 Method Not Allowed", b"method not allowed\n", "text/plain"
            elif path != "/metrics":
                status, body, ctype = "404 Not Found", b"not found\n", "text/plain"
            else:
                status = "200 OK"
                body = self._page().encode("utf-8")
                ctype = "text/plain; version=0.0.4; charset=utf-8"
            head = (f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n"
                    f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("latin-1")
            writer.write(head + (b"" if method == "HEAD" else body))
            await writer.drain()
        except (TimeoutError, ConnectionError):
            pass
        except Exception:
            logger.debug("metrics request failed", exc_info=True)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
