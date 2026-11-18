"""`meshcore-weather --check` (also `meshcore-weather-cli check`): read the
configuration the bot would start with, check every setting a new operator
can get wrong, print a report, and exit 1 if anything is an error.

It never transmits: transmit is switched off in this process before anything
else, and the node is only ever read. Its name and frequency come from the
running bot's portal when one answers on this machine; otherwise the serial
port is opened (APP_START, which sends nothing on air) only when no other
process holds it, so a check run beside the live bot cannot steal its port.

    meshcore-weather --check              # the report; exit 1 on errors
    meshcore-weather --check --no-radio   # without touching the radio at all
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import subprocess
import sys
from pathlib import Path

from meshcore_weather import config
from meshcore_weather.config import settings

OK, INFO, WARN, ERROR, SKIP = "OK", "INFO", "WARN", "ERROR", "SKIP"


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, level: str, topic: str, text: str) -> None:
        self.rows.append((level, topic, text))

    @property
    def errors(self) -> int:
        return sum(1 for r in self.rows if r[0] == ERROR)

    @property
    def warnings(self) -> int:
        return sum(1 for r in self.rows if r[0] == WARN)

    def render(self, tx_was_on: bool) -> str:
        out = [f"meshcore-weather --check ({Path('.env').resolve()})", ""]
        for level, topic, text in self.rows:
            out.append(f"  {level:<6} {topic:<13} {text}")
        out.append("")
        verdict = f"{self.errors} error(s), {self.warnings} warning(s)."
        if self.errors:
            verdict += (" Fix the errors before transmitting" +
                        (": MCW_TX_ENABLED is true, so the bot would go on air with them."
                         if tx_was_on else " (MCW_TX_ENABLED=true)."))
        elif not tx_was_on:
            verdict += " Ready to switch transmit on once the log looks right."
        out.append(verdict)
        return "\n".join(out)


# -- Coverage, home point, time zone -------------------------------------------------


def check_coverage(r: Report) -> None:
    from meshcore_weather.protocol.coverage import Coverage
    try:
        cov = Coverage.from_config()
    except Exception as e:  # noqa: BLE001 - the report states any failure; a check must not end in a traceback
        r.add(ERROR, "Coverage", f"could not be built: {e}")
        return
    for e in cov.errors:
        r.add(ERROR, "Coverage", e)
    for w in cov.warnings:
        r.add(WARN, "Coverage", w)
    if cov.unconfigured:
        r.add(ERROR, "Coverage", cov.blocked)
    elif cov.national:
        r.add(WARN, "Coverage", "MCW_COVERAGE=national: the scheduled broadcasts carry every warning in the "
                                "country. Agree that with your repeater operators first")
    elif not cov.blocked:
        r.add(OK, "Coverage", cov.summary())
    if cov.center:
        r.add(OK, "Home point", f"{cov.home_name} ({cov.center[0]:.4f}, {cov.center[1]:.4f}); radius "
                                f"{settings.home_radius_km} km: is that how far your mesh really reaches?")
    else:
        r.add(ERROR if not cov.national else WARN, "Home point",
              "none: set MCW_HOME_CITIES='City ST' (no home forecast, no observations)")


def check_timezone(r: Report) -> None:
    from zoneinfo import ZoneInfo
    if settings.timezone:
        try:
            ZoneInfo(settings.timezone)
        except (KeyError, ValueError):                 # ZoneInfoNotFoundError is a KeyError
            r.add(ERROR, "Time zone", f"MCW_TIMEZONE={settings.timezone!r} is not an IANA zone (e.g. America/Denver)")
            return
        r.add(OK, "Time zone", f"{settings.timezone} (MCW_TIMEZONE)")
        return
    name, how = config.home_timezone()
    if not name:
        r.add(ERROR, "Time zone", f"MCW_TIMEZONE is empty and cannot be taken from the home city ({how}): "
                                  "set MCW_TIMEZONE, e.g. America/Denver")
        return
    state = how.rsplit("(", 1)[-1].rstrip(")")
    if state in config.SPLIT_TZ_STATES:
        r.add(WARN, "Time zone", f"{name}, {how}; {state} spans more than one time zone, so set MCW_TIMEZONE "
                                 "if that is not yours")
    else:
        r.add(OK, "Time zone", f"{name}, {how}")


# -- Feed, port, channels, keys, portal ----------------------------------------------


def check_emwin(r: Report) -> None:
    src = (settings.emwin_source or "").strip()
    if src == "internet":
        r.add(OK, "EMWIN", f"internet: NOAA's bundles every {settings.emwin_poll_interval} s "
                           "(not fetched by --check)")
    elif src == "sdr":
        d = Path(os.path.expanduser(settings.sdr_emwin_dir))
        if not d.is_dir():
            r.add(ERROR, "EMWIN", f"sdr: {d} does not exist. Is goestools' goesproc writing its EMWIN "
                                  "output there? (MCW_SDR_EMWIN_DIR)")
        else:
            days = sorted(p for p in d.iterdir() if p.is_dir())
            newest = None
            for day in reversed(days[-2:]):
                files = [f.stat().st_mtime for f in day.iterdir() if f.is_file()]
                if files:
                    newest = max(files)
                    break
            import time
            if newest is None:
                r.add(WARN, "EMWIN", f"sdr: {d} has no products yet; the internet backup covers the gap")
            else:
                age = (time.time() - newest) / 60
                r.add(OK if age < 30 else WARN, "EMWIN",
                      f"sdr: {d}, {len(days)} day(s), newest file {age:.0f} min old")
    else:
        r.add(ERROR, "EMWIN", f"MCW_EMWIN_SOURCE={src!r}: must be internet or sdr")
    if settings.radar_dir and not Path(os.path.expanduser(settings.radar_dir)).is_dir():
        r.add(WARN, "Radar", f"MCW_RADAR_DIR {settings.radar_dir} does not exist")


def check_serial(r: Report) -> None:
    port = settings.serial_port
    if port.startswith("tcp://"):
        r.add(OK, "Serial port", f"{port} (a TCP bridge to the radio; not opened by --check)")
        return
    if os.path.exists(port):
        if os.access(port, os.R_OK | os.W_OK):
            r.add(OK, "Serial port", port + (f" -> {os.path.realpath(port)}" if os.path.islink(port) else ""))
        else:
            r.add(ERROR, "Serial port", f"{port} exists but this user cannot open it: add the user to the "
                                        "dialout group (then log in again), or install deploy/99-meshcore-radio.rules")
        return
    from meshcore_weather.meshcore.radio import candidate_ports
    others = [p for p in candidate_ports(port) if p != port]
    if others:
        r.add(WARN, "Serial port", f"{port} is missing; the bot would try {', '.join(others)}. Set "
                                   "MCW_SERIAL_PORT (or install the udev rule for /dev/meshcore)")
    else:
        r.add(ERROR, "Serial port", f"{port} is missing and no USB serial port is present: is the radio plugged in?")


def check_channels(r: Report) -> None:
    text, data, status = settings.meshcore_channel, settings.meshwx_channel, settings.status_channel
    for key, val in (("MCW_MESHCORE_CHANNEL", text), ("MCW_MESHWX_CHANNEL", data), ("MCW_STATUS_CHANNEL", status)):
        if val and not (val.startswith("#") or val.isdigit()):
            r.add(ERROR, "Channels", f"{key}={val!r}: a hashtag channel name starts with '#'")
        if val.strip() == "0":
            r.add(ERROR, "Channels", f"{key}=0 is the public channel: the bot never uses it")
    if text != "#meshwx":
        r.add(WARN, "Channels", f"request channel {text!r}: every weather bot and app uses #meshwx; another "
                                "name splits the users and saves no airtime (repeaters forward any channel)")
    if not data:
        r.add(WARN, "Channels", "MCW_MESHWX_CHANNEL is empty: no broadcasts and no answers for apps")
    elif data != text:
        r.add(WARN, "Channels", f"data channel {data!r} differs from {text!r}: v5 apps listen on #meshwx")
    if status and status in (text, data):
        r.add(ERROR, "Channels", f"MCW_STATUS_CHANNEL {status!r} is the request channel; status lines go "
                                 "on a channel of their own")
    if text == "#meshwx" and data == "#meshwx":
        r.add(OK, "Channels", "#meshwx (requests and datagrams)" + (f", status on {status}" if status else ""))


def check_admin(r: Report) -> None:
    for problem in settings.rejected:
        r.add(ERROR, "Admin key", problem)
    key = settings.admin_key.strip()
    if not key:
        if not settings.rejected:
            r.add(INFO, "Admin key", "none: admin commands by DM are off")
        return
    if len(key) > config.ADMIN_KEY_MAX_HEX:
        r.add(WARN, "Admin key", f"{len(key)} characters: a DM carries only the first 12 of the sender's key, "
                                 "so this never matches. Use the first 12")
    elif len(key) < config.ADMIN_KEY_MAX_HEX:
        r.add(WARN, "Admin key", f"{len(key)} characters: use all 12 of your own key's prefix")
    else:
        r.add(OK, "Admin key", f"{key[:4]}… (12 hex characters)")


def check_portal(r: Report) -> None:
    if not settings.portal_enabled:
        r.add(INFO, "Portal", "off (MCW_PORTAL_ENABLED=false)")
        return
    host, port = settings.portal_host.strip(), settings.portal_port
    hosts = ", ".join(config.portal_allowed_hosts())
    if host in ("127.0.0.1", "localhost", "::1", "[::1]"):
        r.add(OK, "Portal", f"http://{host}:{port}, this machine only (SSH tunnel: "
                            f"ssh -N -L {port}:127.0.0.1:{port} you@this-host); answers Host {hosts}")
    elif host in ("0.0.0.0", "::", "[::]"):
        r.add(WARN, "Portal", f"listens on every interface, port {port}, with no login: anyone who reaches it "
                              f"can drive the radio. Prefer MCW_PORTAL_HOST=127.0.0.1; answers Host {hosts}")
    else:
        r.add(WARN, "Portal", f"listens on {host}:{port} with no login; answers Host {hosts}")
    if settings.bridge_token and host not in ("127.0.0.1", "localhost", "::1", "[::1]"):
        r.add(WARN, "Portal", "the debug bridge (MCW_BRIDGE_TOKEN) is on and the portal is not on localhost")


def check_radio_settings(r: Report) -> None:
    band = config.region_band()
    if band is None:
        r.add(ERROR, "Region", config.frequency_problem(None) or "unknown MCW_RADIO_REGION")
    else:
        r.add(OK, "Region", f"{settings.radio_region.upper()}: {band[0]:g}-{band[1]:g} MHz; other frequencies "
                            "are refused")
    r.add(OK, "Ceiling", f"{settings.scheduled_packets_per_hour} scheduled packets an hour "
                         "(MCW_SCHEDULED_PACKETS_PER_HOUR); life-safety warnings always go")
    if settings.reply_mode == "channel":
        r.add(WARN, "Reply mode", "channel: every reply floods the mesh. Where meshes overlap, dm is kinder")
    else:
        r.add(OK, "Reply mode", settings.reply_mode)


# -- The node itself ----------------------------------------------------------------


def _port_holders(port: str) -> list[str] | None:
    """PIDs of other processes with this device open; None if it cannot be told."""
    real = os.path.realpath(port)
    proc = Path("/proc")
    if proc.is_dir() and (proc / "self" / "fd").is_dir():
        me = str(os.getpid())
        out = []
        for pid_dir in proc.iterdir():
            if not pid_dir.name.isdigit() or pid_dir.name == me:
                continue
            try:
                for fd in (pid_dir / "fd").iterdir():
                    try:
                        if os.path.realpath(fd) == real:
                            out.append(pid_dir.name)
                            break
                    except OSError:
                        continue
            except OSError:
                continue
        return out
    try:
        res = subprocess.run(["lsof", "-t", real], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return [p for p in res.stdout.split() if p.strip() and p.strip() != str(os.getpid())]


async def _from_portal() -> tuple[dict | None, str | None]:
    """The node as the running bot sees it, from its portal on this machine."""
    if not settings.portal_enabled:
        return None, None
    import httpx
    url = f"http://127.0.0.1:{settings.portal_port}/api/radio"
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            res = await c.get(url)
        d = res.json()
    except (httpx.HTTPError, ValueError):
        return None, None
    if not d.get("connected"):
        return None, "the running bot (portal) has no radio connected"
    return d.get("info") or {}, "from the running bot's portal"


async def _from_port(timeout: float) -> tuple[dict | None, str]:
    port = settings.serial_port
    if port.startswith("tcp://"):
        return None, "a TCP bridge is not opened by --check (start the bot with the portal on to check the node)"
    if not os.path.exists(port):
        return None, f"{port} is not present"
    holders = _port_holders(port)
    if holders is None:
        return None, "cannot tell whether another process holds the port; not opened"
    if holders:
        return None, (f"{port} is in use by PID {', '.join(holders)} (the bot?): not opened. Turn the portal on "
                      "to check the node while the bot runs")
    from meshcore_weather.meshcore.radio import _open_serial
    try:
        mc = await asyncio.wait_for(_open_serial(port, settings.serial_baud), timeout)
    except Exception as e:  # noqa: BLE001 - serial, timeout or protocol: any of them means "no answer"
        return None, f"{port}: no answer ({e or type(e).__name__})"
    if mc is None:
        return None, f"{port}: no companion answered (firmware 'Companion Radio USB'?)"
    try:
        return dict(mc.self_info or {}), f"read from {port} (APP_START only, nothing sent on air)"
    finally:
        with contextlib.suppress(Exception):
            await mc.disconnect()


async def read_node(timeout: float = 25.0) -> tuple[dict | None, str]:
    info, how = await _from_portal()
    if info is not None or how:
        return info, how or ""
    return await _from_port(timeout)


def check_node(r: Report, info: dict | None, how: str) -> None:
    if info is None:
        r.add(SKIP, "Node", f"not checked: {how}")
        if settings.mqtt_enabled and not settings.mqtt_iata.strip():
            r.add(WARN, "MQTT", "MCW_MQTT_IATA is empty: the topic takes the node's WX-<IATA> name, not checked here")
        return
    name = info.get("name")
    problem = config.node_name_problem(name)
    r.add(WARN if problem else OK, "Node name", (problem or f"{name}: check that no other bot near you uses it")
          + f" ({how})")
    freq, bw = info.get("radio_freq"), info.get("radio_bw")
    if isinstance(freq, (int, float)):
        fp = config.frequency_problem(freq, bw)
        r.add(ERROR if fp else OK, "Node radio",
              (fp + ": the bot switches transmit off at start") if fp else
              f"{freq:g} MHz, {bw:g} kHz, SF{info.get('radio_sf')}, CR{info.get('radio_cr')}")
    if settings.mqtt_enabled:
        iata = settings.mqtt_iata.strip() or config.iata_from_name(name)
        r.add(OK if iata else ERROR, "MQTT", f"topic region {iata}" if iata else
              "MCW_MQTT_IATA is empty and the node name has no WX-<IATA>: MQTT stays off")


def check_mqtt_settings(r: Report) -> None:
    if settings.mqtt_enabled and settings.mqtt_iata.strip():
        r.add(OK, "MQTT", f"{settings.mqtt_host}:{settings.mqtt_port}, region {settings.mqtt_iata}")


# -- Entry ------------------------------------------------------------------------------


def run(argv: list[str] | None = None, out=None) -> int:
    argv = list(argv or [])
    out = out or sys.stdout
    tx_was_on = settings.tx_enabled
    settings.tx_enabled = False                 # nothing this process does may reach the air
    if "--verbose" not in argv:
        logging.disable(logging.CRITICAL)       # the report says it; the library chatter would repeat it
    try:
        from meshcore_weather.geodata import resolver
        resolver.load()
        r = Report()
        check_coverage(r)
        check_timezone(r)
        check_emwin(r)
        check_serial(r)
        check_channels(r)
        check_radio_settings(r)
        check_admin(r)
        check_portal(r)
        check_mqtt_settings(r)
        if "--no-radio" in argv:
            check_node(r, None, "--no-radio")
        else:
            info, how = asyncio.run(read_node())
            check_node(r, info, how)
        r.add(INFO, "Transmit", "ON (MCW_TX_ENABLED=true)" if tx_was_on else
              "off (MCW_TX_ENABLED=false): receive only. Watch the log, then switch it on")
        print(r.render(tx_was_on), file=out)
        return 1 if r.errors else 0
    finally:
        logging.disable(logging.NOTSET)
        settings.tx_enabled = tx_was_on


def main(argv: list[str] | None = None) -> int:
    return run(sys.argv[1:] if argv is None else argv)
