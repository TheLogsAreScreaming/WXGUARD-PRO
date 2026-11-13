"""Main entry point - wires EMWIN data, parser, and Meshcore radio together."""

import asyncio
import json
import logging
import random
import re
import signal
import sys
import time
from pathlib import Path

from meshcore_weather.config import settings
from meshcore_weather.emwin.fetcher import create_source
from meshcore_weather.geodata import resolver, zip_code
from meshcore_weather.meshcore.delivery import DM_MAX_BYTES, DmReply, DmRequests, clip_bytes, dm_outbox
from meshcore_weather.meshcore.radio import MeshcoreRadio
from meshcore_weather.nlp import is_conversation, parse_intent, strip_mentions
from meshcore_weather.core.pages import split_pages
from meshcore_weather.core.render_text import MAX_DM
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.traffic import traffic_log

logger = logging.getLogger(__name__)

RADIO_RETRY_SECONDS = 60
# "@lat,lon <command>": a DM that carries the sender's position
LOC_PREFIX = re.compile(r"^@(-?\d+\.?\d*),(-?\d+\.?\d*)\s+(.*)")

# One message, under the channel budget, no newlines (phones wrap it).
# A DM already is the private reply, so it does not say "DM me".
HELP_TEXT_DM = (
    "Weather bot: wx/forecast/warn/radar <city ST|ZIP> | warn/storm/rain <ST> | "
    "metar <ICAO|ZIP> | space | sat | cov | more"
)
HELP_TEXT = HELP_TEXT_DM + ". DM me for private replies"

# What a restart says while its products are still loading (see _load_backlog).
NOT_READY_TEXT = "Starting up: my weather products are still loading. Ask again in a minute."


STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "puerto rico": "PR", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC", "guam": "GU", "virgin islands": "VI",
}

VALID_STATES = set(STATE_NAMES.values())


def channel_fit(text: str, budget: int) -> str:
    """One channel message: the whole reply if it fits, else the reply cut at
    a list boundary with a note. Never cut mid-word, never overflow.
    `budget` is UTF-8 bytes (radio.channel_text_budget)."""
    text = text.replace("\n", " ").strip()
    if len(text.encode()) <= budget:
        return text
    note = " … DM me for all"
    cut = clip_bytes(text, budget - len(note.encode()))
    room = len(cut)
    for sep in ("; ", " | ", ", ", " "):
        i = cut.rfind(sep)
        if i > room * 3 // 5:
            cut = cut[:i]
            break
    return cut.rstrip(" ;|,") + note


def reply_not_before(hops: int | None, t0: float | None = None) -> float:
    """When the answer to a request heard at `t0` (time.monotonic) may go
    out. A request that came through repeaters is still being passed on
    when it reaches us, and an answer sent straight away goes out under the
    repeaters' own copies of it: on 1 October 12 of 35 answers sent within a
    third of a second of a relayed request lost their first copy, and none
    of the 8 sent later did. A request heard direct (or of unknown route) is
    answered at once."""
    t0 = time.monotonic() if t0 is None else t0
    delay = settings.relayed_reply_delay_s
    if not hops or delay <= 0:
        return t0
    return t0 + delay + random.uniform(0, delay / 2)


async def wait_until(t: float) -> None:
    """Sleep until time.monotonic() reaches `t`."""
    wait = t - time.monotonic()
    if wait > 0:
        await asyncio.sleep(wait)


async def _cancel(task: asyncio.Task | None) -> None:
    """Cancel one of our tasks and wait for it to end, so nothing of ours is
    still pending when the loop closes."""
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.debug("Task ended with an error while shutting down", exc_info=True)


class WeatherBot:
    """Main application: bridges EMWIN weather data to Meshcore radio."""

    _CONTACTS_FILE = Path(settings.data_dir) / "known_contacts.json"

    def __init__(self):
        self.emwin = create_source()
        self.radio = MeshcoreRadio()
        self.store = WeatherStore()
        self._running = False
        self._refresh_task: asyncio.Task | None = None
        self._radio_task: asyncio.Task | None = None
        self._backlog_task: asyncio.Task | None = None
        self._restart_task: asyncio.Task | None = None
        self._radio_last_error: str | None = None
        # (time, reason) of each lost link: on 2026-10-01 the radio and the
        # dish receiver fell off USB together four times in five minutes.
        self.link_drops: list[tuple[float, str]] = []
        self._started_at: float = time.time()
        # Set until start() clears it: a bot built by a test, the CLI or the
        # portal owns whatever is in its store from the first call. On a real
        # start the on-disk backlog sets it again when it is in (_load_backlog),
        # and until then requests get NOT_READY_TEXT and the scheduler holds.
        self._store_ready = asyncio.Event()
        self._store_ready.set()
        # The one way out: a signal or the portal's restart sets it and the
        # run loop below stops the bot (see run()). Nothing calls loop.stop().
        self._exit = asyncio.Event()
        self._broadcaster = None  # MeshWXBroadcaster, created if data channel configured
        self._coverage_cache = None  # built from the env config when no broadcaster runs
        self._portal = None  # PortalServer, created if portal enabled
        self._metrics = None  # MetricsExporter, created if an export is configured
        self._paging: dict[str, dict] = {}  # sender_key -> {full, offset, ts}
        self._rate_limit: dict[str, float] = {}
        self._reply_history: dict[str, list[float]] = {}
        self._all_replies: list[float] = []
        self._channel_reply_by_sender: dict[str, float] = {}
        self._channel_replies: list[float] = []
        # DM requests and replies (meshcore/delivery.py): copies of a request,
        # the per-contact reply queue. The clock is injectable for tests.
        self._clock = time.time
        self._dm_requests = DmRequests()
        self.dm_outbox = dm_outbox
        self._sdr_monitor = None
        # Map sender names to pubkey prefixes — persisted to disk
        self._known_contacts: dict[str, str] = {}  # name -> pubkey_prefix
        # Names where DM has failed — don't try again until they re-advert
        self._dm_blocked: set[str] = set()
        # Track channel usage for unknown contacts
        # Track consecutive channel msgs from known contacts (DM may not be working)
        self._load_known_contacts()

    @property
    def store_ready(self) -> bool:
        """Is the on-disk product backlog in the store? False only between the
        start of a restart and the end of its first ingest."""
        return self._store_ready.is_set()

    async def start(self) -> None:
        t0 = time.monotonic()
        logger.info("Starting Meshcore Weather Bot")
        logger.info("  Serial port: %s", settings.serial_port)
        logger.info("  EMWIN source: %s", settings.emwin_source)
        logger.info("  Channel: %s", settings.meshcore_channel)

        from meshcore_weather.meshcore.delivery import loop_lag
        from meshcore_weather.portal import logbuf
        loop = asyncio.get_running_loop()
        logbuf.install(loop)   # console buffer catches everything from here on
        traffic_log.install(loop)
        # Watch how late our own event loop runs: a stalled loop delays the
        # echo handler and would otherwise read as a radio that cannot
        # transmit (see meshcore/delivery.py LoopLag).
        loop_lag.start()
        self._running = True
        # Geodata before the radio: every command that arrives is parsed
        # against it, and it is seconds, not minutes. In a thread so the
        # loop keeps running while the JSON is read.
        await loop.run_in_executor(None, resolver.load)   # also sets home from MCW_HOME_CITIES
        if settings.emwin_source == "sdr":
            from meshcore_weather.sdr_monitor import SdrMonitor
            self._sdr_monitor = SdrMonitor()
            self._sdr_monitor.start()
        self.radio.on_channel_message(self._handle_channel_message)
        self.radio.on_channel_request(self._handle_channel_request)
        self.radio.on_dm(self._handle_dm)
        self.radio.on_advert(self._handle_advert)
        self.radio.on_disconnect(self._handle_radio_lost)

        # The radio comes up before the products. Reading a Pi's 14k EMWIN
        # files off the card and parsing them takes a minute or two, and the
        # node used to be deaf for all of it: every deploy cost ~100 s of
        # silence, DMs included. The backlog now loads behind the radio, and
        # until it is in, requests get an honest not-ready answer
        # (NOT_READY_TEXT / Not available reason 0) and the scheduler holds
        # its broadcasts.
        self._store_ready.clear()
        self._backlog_task = asyncio.create_task(self._load_backlog())

        # The radio may not be plugged in yet (a Pi whose Heltec arrives
        # later, a USB cable pulled). Keep serving the store, portal and
        # CLI, and keep trying the radio until it answers.
        try:
            await self.radio.start()
        except Exception as e:
            self._radio_last_error = str(e)
            logger.warning("Radio not available (%s); retrying every %ds", e, RADIO_RETRY_SECONDS)
            self._radio_task = asyncio.create_task(self._radio_retry_loop())
        else:
            logger.info("Meshcore radio connected %.1f s after start", time.monotonic() - t0)
            await self._after_radio_connected()

        # Start local operator web portal if enabled
        if settings.portal_enabled:
            try:
                from meshcore_weather.portal.server import PortalServer
                self._portal = PortalServer(self)
                await self._portal.start()
            except ImportError as e:
                logger.warning("Portal disabled: %s (run `pip install meshcore-weather[portal]`)", e)

        # Weather history export (InfluxDB push / Prometheus page), off by default.
        try:
            from meshcore_weather.metrics import MetricsExporter
            self._metrics = MetricsExporter.from_settings(
                self.store, settings, radio_connected=lambda: self.radio.channel_idx is not None)
            if self._metrics is not None:
                await self._metrics.start()
        except OSError as e:
            logger.warning("Metrics export disabled: %s", e)
            self._metrics = None

        if self.radio.channel_idx is not None:
            logger.info(
                "Weather bot is running. Listening on channel %d (%s) + DMs",
                self.radio.channel_idx,
                settings.meshcore_channel,
            )
        else:
            logger.info("Weather bot is running without a radio (store, portal and CLI only)")

    async def _after_radio_connected(self) -> None:
        """Start the data-channel broadcaster once a radio with a data channel
        is up. It answers `>` requests straight away; `ready` keeps its
        scheduled broadcasts back until the product backlog is in."""
        if self.radio.data_channel_idx is not None:
            from meshcore_weather.protocol.broadcaster import AppResponder
            self._broadcaster = AppResponder(self.store, self.radio, ready=self._store_ready,
                                             render_text=self._process_command)
            await self._broadcaster.start()

    async def _handle_radio_lost(self, reason: str) -> None:
        """The radio reports its link is gone: reconnect in the background
        (a swapped board is adopted on the way) and keep serving meanwhile."""
        self._radio_last_error = f"link lost: {reason}"
        self.link_drops = [d for d in self.link_drops if time.time() - d[0] < 86400][-99:] + [(time.time(), reason)]
        logger.warning("Reconnecting to the radio after a lost link (%s)", reason)
        self._radio_task = asyncio.create_task(self.reconnect_radio())

    async def reconnect_radio(self) -> None:
        """Drop the radio link and connect again (serial port changed, node
        rebooted). Falls back to the retry loop if it does not come up."""
        if self._radio_task and self._radio_task is not asyncio.current_task():
            self._radio_task.cancel()
        self._radio_task = None
        try:
            await self.radio.stop()
        except Exception:
            pass
        if self._broadcaster:
            try:
                await self._broadcaster.stop()
            except Exception:
                pass
            self._broadcaster = None
        self.radio = MeshcoreRadio()
        self.radio.on_channel_message(self._handle_channel_message)
        self.radio.on_channel_request(self._handle_channel_request)
        self.radio.on_dm(self._handle_dm)
        self.radio.on_advert(self._handle_advert)
        self.radio.on_disconnect(self._handle_radio_lost)
        try:
            await self.radio.start()
        except Exception as e:
            self._radio_last_error = str(e)
            logger.warning("Radio not available after reconnect (%s); retrying every %ds", e, RADIO_RETRY_SECONDS)
            self._radio_task = asyncio.create_task(self._radio_retry_loop())
            return
        self._radio_last_error = None
        await self._after_radio_connected()

    # -- Shutdown ------------------------------------------------------------
    #
    # A signal and the portal's restart button take the same road: set the
    # exit event, let main()'s run loop stop the bot and return. Nothing
    # stops the loop under a coroutine that is still running, which is what
    # used to end every systemd stop with "Event loop stopped before Future
    # completed" and status=1/FAILURE.

    def request_stop(self) -> None:
        """Ask the run loop to shut the bot down. The only way out."""
        self._exit.set()

    async def wait_for_exit(self) -> None:
        await self._exit.wait()

    def request_restart(self, delay: float = 0.5) -> None:
        """Exit cleanly a moment from now; systemd (Restart=always) brings the
        bot back with the current .env."""
        async def _go():
            await asyncio.sleep(delay)
            logger.info("Restart requested from the portal; exiting")
            self.request_stop()

        self._restart_task = asyncio.get_running_loop().create_task(_go())

    async def _radio_retry_loop(self) -> None:
        while self._running:
            await asyncio.sleep(RADIO_RETRY_SECONDS)
            try:
                await self.radio.start()
            except Exception as e:
                self._radio_last_error = str(e)
                logger.debug("Radio still not available: %s", e)
                continue
            self._radio_last_error = None
            logger.info("Radio connected after retry. Listening on channel %s (%s) + DMs",
                        self.radio.channel_idx, settings.meshcore_channel)
            await self._after_radio_connected()
            return

    async def stop(self) -> None:
        """Stop everything this bot started, in the reverse order, and wait for
        each of it. Called once, from main()'s run loop: when it returns, no
        task of ours is left running and the process can exit 0."""
        logger.info("Shutting down Weather Bot")
        self._running = False
        await _cancel(self._backlog_task)        # first: it is what starts the refresh loop
        for task in (self._restart_task, self._radio_task, self._refresh_task):
            await _cancel(task)
        for what, part in (("metrics export", self._metrics),
                           ("portal", self._portal), ("receiver monitor", self._sdr_monitor),
                           ("broadcaster", self._broadcaster), ("radio", self.radio),
                           ("EMWIN source", self.emwin)):
            if part is None:
                continue
            try:
                await part.stop()
            except Exception:
                # A start cut short by a signal leaves things half-built; one
                # that cannot be stopped must not strand the rest.
                logger.warning("Could not stop the %s cleanly", what, exc_info=True)
        from meshcore_weather.meshcore.delivery import delivery_tracker, loop_lag
        await loop_lag.stop()
        traffic_log.flush(force=True)
        delivery_tracker.flush_outcomes()
        logger.info("Weather bot stopped")

    # -- The product backlog --------------------------------------------------

    # The store's parse is CPU-bound, so it runs in a worker thread, and in
    # chunks: the loop gets the thread back between them, which keeps the
    # radio's serial reads (and the echo matching in meshcore/delivery.py)
    # flowing while a restart loads thousands of products.
    INGEST_CHUNK = 500

    async def _load_backlog(self) -> None:
        """Everything already on disk, loaded behind the radio. Nothing here
        touches the air. When it finishes the store is ready: requests are
        answered for real and the scheduler may broadcast."""
        t0 = time.monotonic()
        try:
            await self.emwin.start()
            await self._refresh_store(quiet=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("The product backlog could not be loaded; the bot serves what it has")
        finally:
            self._store_ready.set()
        logger.info("Backlog loaded: %d products in %.1f s",
                    len(self.store._products), time.monotonic() - t0)
        self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def _refresh_loop(self) -> None:
        while self._running:
            await asyncio.sleep(settings.emwin_poll_interval)
            await self._refresh_store()

    async def _refresh_store(self, quiet: bool = False) -> None:
        products = await self.emwin.fetch_products()
        if products:
            new = await self._ingest(products)
            if new and not quiet:
                logger.info("Ingested %d new product(s) (%d held)", new, len(self.store._products))
            await self._warm_warnings()

    async def _ingest(self, products: list[dict]) -> int:
        """Parse products into the store off the event loop. Returns how many
        were new (the sources hand back their whole cache every poll)."""
        loop = asyncio.get_running_loop()
        new = 0
        for i in range(0, len(products), self.INGEST_CHUNK):
            new += await loop.run_in_executor(None, self.store.ingest,
                                              products[i:i + self.INGEST_CHUNK], False)
        return new

    async def _warm_warnings(self) -> None:
        """Parse new warning products now, off the event loop, so the first
        DM after a refresh does not wait on pyIEM (15-25 s on a Pi 4)."""
        from functools import partial
        from meshcore_weather.protocol.warnings import extract_active_warnings
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, partial(extract_active_warnings, self.store, coverage=None))
        except Exception:
            logger.debug("warning cache warm-up failed", exc_info=True)

    # -- Message handling --

    async def _handle_channel_message(self, channel: str, sender: str, text: str,
                                      hops: int | None = None) -> None:
        """Handle a message received on a channel. `hops` is how many
        repeaters the packet crossed (None when the frame did not say)."""
        ch = int(channel)
        if ch == 0:
            return
        text = text.strip()
        # Bots ignore bots: another WX-* node's channel reply is not a request.
        if sender.upper().startswith(settings.peer_bot_prefix.upper()):
            if text:
                traffic_log.record("peer", sender=sender, text=text, hops=hops)
            return

        if not text:
            return

        # An app request (">w", ">f 102"): answered on the data channel.
        if text.startswith(">"):
            await self._handle_app_request(text, sender, self.person_key(sender), "channel", hops)
            return

        # Text commands only on the text channel — don't parse data channel noise
        if ch != self.radio.channel_idx:
            return

        arrived = self._clock()
        req = traffic_log.record("channel_in", sender=sender, text=text, hops=hops)
        # People talk on the channel too, and a reply to that is noise flooded
        # across the mesh (nlp.is_conversation). Recorded, not answered.
        if is_conversation(text, resolve=resolver.resolve, states=VALID_STATES):
            logger.info("Channel msg from %s is conversation, not a request: no reply", sender)
            traffic_log.record("dropped", reason="conversation, not a request", req=req)
            return
        text = strip_mentions(text)
        command, location = await self._parse(text)
        traffic_log.update(req, command=command, location=location)
        if not self._rate_check(sender, follow_up=(command == "more")):
            traffic_log.record("dropped", reason="rate limit", req=req, text=text)
            return

        # Replies go by DM when we can: a DM with a known path costs only
        # the repeaters on it, a channel reply floods every repeater. For a
        # sender we cannot DM (their phone has never heard our advert, or
        # ours has never heard theirs) we answer once on OUR channel, never
        # on the public one, rate-limited, and advert so the next exchange
        # can be a DM.
        if not self._we_answer(command, location):
            traffic_log.record("dropped", reason="a nearer bot answers", req=req)
            return
        mode = settings.reply_mode
        if mode == "channel":
            await self._respond_channel(sender, command, location, hops, forced=True, req=req)
            return
        pubkey = self._resolve_sender_key(sender)
        if not pubkey:
            if mode == "dm_only":
                logger.info("Channel command from %s: no DM path and reply_mode=dm_only — ignoring", sender)
                traffic_log.record("dropped", reason="no DM path (dm_only)", req=req)
                return
            await self._respond_channel(sender, command, location, hops, req=req)
            return
        await self._respond_dm(pubkey, sender, command, location, req=req, arrived_at=arrived)

    # Commands that name a place are answered by the nearest bot only.
    _PLACE_COMMANDS = {"wx", "forecast", "warn", "outlook", "metar", "taf", "nowcast"}

    def _we_answer(self, command: str, location: str) -> bool:
        """Overlap rule: for a request that names a place, answer only if we
        are the nearest weather bot to that place among the bots we have
        heard adverts from (ties: lower public key). Requests without a
        place are answered by every bot that hears them (by DM, cheap)."""
        if command not in self._PLACE_COMMANDS or not location:
            return True
        peers = self.radio.peer_bots() if hasattr(self.radio, "peer_bots") else []
        if not peers:
            return True
        home = resolver.home()
        if home is None:
            return True
        loc = resolver.resolve(location)
        if not loc or loc.get("lat") is None:
            return True                      # unresolvable: let the reply say so
        from meshcore_weather.geodata import _haversine
        mine = _haversine(home[0], home[1], loc["lat"], loc["lon"])
        my_key = (getattr(self.radio, "public_key", "") or "").lower()
        for p in peers:
            d = _haversine(p["lat"], p["lon"], loc["lat"], loc["lon"])
            if d < mine or (d == mine and p["public_key"].lower() < my_key):
                logger.info("Not answering %s %r: %s is nearer (%.0f km vs our %.0f km)",
                            command, location, p["name"], d, mine)
                return False
        return True

    # Channel-reply budget for senders we cannot DM: per sender and overall.
    # The defaults; the checks read settings.stranger_reply_gap_s and
    # settings.stranger_replies_per_hour, which the portal sets live.
    CHANNEL_REPLY_PER_SENDER_S = 600
    CHANNEL_REPLY_PER_HOUR = 12

    async def _respond_channel(self, sender: str, command: str, location: str,
                               hops: int | None = None, forced: bool = False,
                               req: dict | None = None) -> None:
        """Reply on our own channel (a flood). `forced` is reply_mode=channel;
        otherwise this is the stranger fallback with its hop gate and budget."""
        now = time.time()
        if not forced:
            if hops is not None and hops > settings.channel_reply_max_hops:
                logger.info("Channel command from %s: no DM path and %d hops away — too far for a channel reply",
                            sender, hops)
                traffic_log.record("dropped", reason=f"no DM path, {hops} hops away", req=req, sender=sender)
                return
            self._channel_replies = [ts for ts in getattr(self, "_channel_replies", []) if now - ts < 3600]
            last = self._channel_reply_by_sender.get(sender, 0.0)
            if now - last < settings.stranger_reply_gap_s:
                logger.info("Channel command from %s: no DM path, channel reply already sent %ds ago — ignoring",
                            sender, int(now - last))
                traffic_log.record("dropped", reason=f"no DM path, channel reply {int(now - last)}s ago",
                                   req=req, sender=sender)
                return
            if len(self._channel_replies) >= settings.stranger_replies_per_hour:
                logger.warning("Channel command from %s: no DM path and the hourly channel-reply budget is spent — ignoring", sender)
                traffic_log.record("dropped", reason="hourly channel-reply budget spent", req=req, sender=sender)
                return
        if forced:
            # Channel mode: the same paged reply a DM would get, so "more" works.
            chunk, _ = self.reply_chunk(command, location, self.person_key(sender))
        else:
            # A stranger gets one message and no paging session: their "more"
            # would only hit the per-sender channel gate. DM is the way to the rest.
            response = self._process_command(command, location)
            chunk = channel_fit(response, self.radio.channel_text_budget()) if response else None
        if not chunk:
            traffic_log.record("dropped", reason="nothing to say", req=req, sender=sender)
            return
        if not forced:
            self._channel_reply_by_sender[sender] = now
            self._channel_replies.append(now)
            logger.info("Channel command from %s: no DM path, replying on our channel (flood)", sender)
        else:
            logger.info("Channel command from %s: reply_mode=channel, replying on our channel (flood)", sender)
        await wait_until(reply_not_before(hops, (req or {}).get("_t0")))
        ev = traffic_log.record("reply_channel", text=chunk, chars=len(chunk), req=req, sender=sender,
                                command=command, location=location, ok=settings.tx_enabled)
        sent = await self.radio.send_channel_message(self.radio.channel_idx, chunk, ev=ev)
        if sent is False and settings.tx_enabled:
            traffic_log.update(ev, ok=False, reason="the node did not send it", push=True)
        if not forced and await self.radio.advert_if_stale():
            logger.info("Adverted so %s can DM us next time", sender)

    # -- Request datagrams (spec 7B) -----------------------------------------
    #
    # Since revision 6 an app's `>` request normally arrives as a GRP_DATA
    # datagram flooded on #meshwx, not as a DM: a flood needs no route, and a
    # stale route is what used to lose the DMs silently. Nothing about the
    # answer changes, and nothing about the limits: a datagram meets the app
    # limiter inside the broadcaster (5 s per sender, 60 packets an hour) and
    # not the limiter for people's text commands, exactly like a `>` line sent
    # as channel text. The sender is the six key bytes in the datagram, which
    # is the prefix a DM from the same phone carries, so one phone is one
    # sender to the limits and to the copy rule however it asks.

    def bot_id(self) -> int:
        """The `bot` field of our own v5 headers: the first two bytes of our
        public key, little-endian. The scheduler owns it when broadcasts are
        on, so an answer and this check can never disagree."""
        sched = getattr(self._broadcaster, "scheduler", None)
        if sched is not None:
            return sched.bot_id()
        from meshcore_weather.protocol import v5_builders as b
        return b.bot_id(getattr(self.radio, "public_key", "") or None)

    def _name_for_key(self, prefix: str) -> str | None:
        """The name we know a public-key prefix by, if we know one at all."""
        for name, key in self._known_contacts.items():
            if key == prefix:
                return name
        try:
            contact = self.radio.find_contact_by_key(prefix)
        except Exception:
            contact = None
        name = str((contact or {}).get("adv_name") or "").strip()
        return name or None

    async def _handle_channel_request(self, request, hops: int | None = None,
                                      snr: float | None = None) -> None:
        """An app's Request datagram on our own channel (spec 7B). `request`
        is a decoded `v5.Request`; the radio has already checked its shape."""
        from meshcore_weather.protocol import v5

        mine = self.bot_id()
        if request.bot != v5.REQUEST_BOT_ANY and request.bot != mine:
            logger.debug("Request datagram for bot %04X, not us (%04X) — ignoring",
                         request.bot, mine)
            return
        text = request.text.strip()
        if not text.startswith(">"):
            return

        prefix = self._normalize_key(request.sender_prefix)
        sender_name = self._name_for_key(prefix) or f"app:{prefix}"
        now = self._clock()
        # An app sends the same bytes again when no answer arrives (spec 13).
        # Copies are recognised on the same record a DM copy is, so a phone
        # that falls back to a DM does not get the answer twice.
        async with self._dm_requests.lock(prefix):
            dreq, how = self._dm_requests.match(prefix, request.ts, text, now)
            action = self._copy_action(dreq, now) if how else None
        if how:
            await self._handle_dm_copy(dreq, how, action, prefix, sender_name, text,
                                       request.ts, now, transport="channel_data",
                                       answer=lambda d: self._answer_channel_request(
                                           d, prefix, sender_name, text, hops))
            return
        dreq.ev = traffic_log.record("data_request", sender=sender_name, key=prefix,
                                     text=text[:40], transport="channel_data", hops=hops)
        await self._answer_channel_request(dreq, prefix, sender_name, text, hops)

    async def _answer_channel_request(self, dreq, prefix: str, sender_name: str, text: str,
                                      hops: int | None) -> None:
        """Answer one Request datagram. A request that ends in an error is
        left unanswered, so its next copy is answered again (as a DM is)."""
        try:
            await self._handle_app_request(text, sender_name, prefix, "channel_data", hops,
                                           req=dreq.ev, dreq=dreq)
        except Exception:
            if dreq.state == "building" or (dreq.state == "app" and dreq.app_done_at is None):
                dreq.state = "limited"
            logger.warning("Request datagram from %s ended in an error; its next copy "
                           "is answered again", sender_name)
            raise

    async def _handle_dm(self, pubkey_prefix: str, sender_name: str, text: str,
                         sender_ts: int | None = None, path_len: int | None = None) -> None:
        """Handle a direct message. With the text, `sender_ts` (the sender's
        own timestamp) tells a copy of an earlier request from a new one."""
        text = text.strip()
        if not text:
            return

        prefix = self._normalize_key(pubkey_prefix)
        now = self._clock()
        loc = LOC_PREFIX.match(text)
        paging_on = None
        if (await self._parse(loc.group(3) if loc else text))[0] == "more":
            paging_on = lambda candidate: self._more_copy_of(prefix, candidate)    # noqa: E731
        # A sender's app sends a DM again when it hears no ACK. Copies are
        # recognised first, so the rate limiter never sees one.
        async with self._dm_requests.lock(prefix):
            dreq, how = self._dm_requests.match(prefix, sender_ts, text, now, paging_on=paging_on)
            action = self._copy_action(dreq, now) if how else None
        if how:
            await self._handle_dm_copy(dreq, how, action, prefix, sender_name, text, sender_ts, now)
            return
        dreq.ev = traffic_log.record("dm_in", sender=sender_name, key=prefix, text=text)
        await self._answer_dm(dreq, prefix, sender_name, text, now)

    def _more_copy_of(self, prefix: str, candidate):
        """`more` with a new sender timestamp. People page on quickly, so the
        same text alone does not make a copy. It copies the `more` before it
        (for the first `more`, the command that opened the session) only while
        that reply is queued, being tried or failed: a sender that retries with
        a new timestamp never queues another page while one is in flight, and a
        failed page goes again instead of being skipped. Once that reply is
        confirmed, this is the next page."""
        if candidate is not None:
            reply = candidate.reply
            return None if reply is not None and reply.state == "confirmed" else candidate
        last = (self._paging.get(prefix) or {}).get("last")
        if last is None or last.state == "confirmed":
            return None
        return last.request

    # A `>` request is answered with channel datagrams, which carry no ACK, so
    # a copy of one cannot wait for a confirmation. Apps resend automatically
    # 5-6 s apart; the iOS weather tool asks again after 15 s of silence. A
    # copy is answered again only this long after the last answer went out.
    APP_COPY_GAP_S = 12

    def _copy_action(self, dreq, now: float) -> str:
        """What a copy of `dreq` gets, decided and claimed under the sender's
        lock: "answer" (it was never answered: answer it now), "redeliver"
        (the same reply again), or the reason it gets nothing."""
        state = dreq.state
        # "not_ready": the first copy got the starting-up note, which spent no
        # budget; this one is answered again, by now perhaps for real.
        if state in ("limited", "app_unanswered", "not_ready"):
            dreq.state = "building"
            return "answer"
        if state == "app":
            if dreq.app_done_at is None:
                return "app answer still going out"
            if now - dreq.app_done_at < self.APP_COPY_GAP_S:
                return f"app answer went out {now - dreq.app_done_at:.0f} s ago"
            dreq.state = "building"
            return "answer"
        if state == "replied":
            r = dreq.reply
            if r.state == "confirmed":
                return "reply confirmed"
            if r.state in ("failed", "dropped"):
                r.state = "queued"
                return "redeliver"
            return "reply queued or being tried"
        if state == "building":
            return "request still being handled"
        return "request not answered"

    async def _handle_dm_copy(self, dreq, how: str, action: str, prefix: str, sender_name: str, text: str,
                              sender_ts: int | None, now: float, transport: str = "dm",
                              answer=None) -> None:
        """A copy of a request already on record. `transport` and `answer` are
        for the Request datagram (spec 7B), which shares every rule here and
        only differs in how the answer is built: `answer(dreq)` builds it, and
        a datagram answer is never a queued reply that could be redelivered."""
        gap = now - dreq.first_at
        logger.info("%s copy %d of a request from %s (%s, ts %s, %.1f s after the first): %s",
                    "DM" if transport == "dm" else "Datagram",
                    dreq.copies, sender_name, how, sender_ts, gap, action)
        traffic_log.record("dm_copy", sender=sender_name, key=prefix, text=text, req=dreq.ev,
                           transport=transport,
                           reason=f"copy {dreq.copies}, {how}, +{gap:.0f} s: {action}")
        self.dm_outbox.note_copy(dreq.reply)
        if action == "answer":
            if answer is not None:
                await answer(dreq)
                return
            await self._answer_dm(dreq, prefix, sender_name, text, now, copy=True)
        elif action == "redeliver" and answer is None:
            # A queued DM reply to send again. A datagram answer is never one:
            # it was flooded, unacknowledged, and is rebuilt, never redelivered.
            r = dreq.reply
            if not self._rate_check(prefix, copy=True):
                r.state = "failed" if r.tries else "dropped"
                traffic_log.record("dropped", reason="rate limit", req=dreq.ev)
                return
            await self.dm_outbox.submit(r, lambda: self.radio, not_before=now + settings.dm_reply_delay_s)

    async def _answer_dm(self, dreq, prefix: str, sender_name: str, text: str, arrived: float,
                         copy: bool = False) -> None:
        """Answer a DM request when it arrives, or when a copy of one the rate
        limiter dropped comes in (`copy`: the per-sender spacing is skipped).
        A request that ends in an error is left for its next copy to answer."""
        try:
            await self._answer_dm_now(dreq, prefix, sender_name, text, arrived, copy)
        except Exception:
            if dreq.state == "building" or (dreq.state == "app" and dreq.app_done_at is None):
                dreq.state = "limited"
            logger.warning("DM request from %s ended in an error; its next copy is answered again", sender_name)
            raise

    async def _answer_dm_now(self, dreq, prefix: str, sender_name: str, text: str, arrived: float,
                             copy: bool) -> None:
        req = dreq.ev

        # Parse @lat,lng prefix for location-aware commands
        loc_match = LOC_PREFIX.match(text)
        if loc_match:
            try:
                lat = float(loc_match.group(1))
                lon = float(loc_match.group(2))
            except ValueError:
                lat = lon = None
            text = loc_match.group(3)
            if lat is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
                if not hasattr(self, "_user_locations"):
                    self._user_locations = {}
                if len(self._user_locations) > 2000:
                    self._user_locations.clear()
                self._user_locations[prefix] = (lat, lon)
                logger.info("Cached location for %s: %.4f, %.4f", sender_name, lat, lon)

        # Every DM meets the people's limiter, `>` app requests included (spec 8.2).
        command, location = await self._parse(text)
        traffic_log.update(req, command=command, location=location)

        # A restart answers honestly and for free until its products are in.
        # Answering now rather than queueing the request is deliberate: the
        # sender's app is already resending (meshcore/delivery.py), and a held
        # request would be answered twice, minutes late, against a budget the
        # sender never meant to spend. So the note is sent at once and costs
        # nothing, and the real reply they ask for a minute later is still
        # within their hour. A copy of this request is answered again, by
        # which time the store may well be ready.
        if not self.store_ready and self._needs_store(text, command):
            await self._not_ready_reply(dreq, prefix, sender_name, text, req, arrived)
            return

        if not self._rate_check(prefix, follow_up=(command == "more"), copy=copy):
            logger.debug("DM rate-limited from %s", sender_name)
            traffic_log.record("dropped", reason="rate limit", req=req)
            dreq.state = "limited"
            return

        # They're DMing us — DMs work both ways, clear all blocks
        if sender_name and sender_name != "unknown":
            is_new = sender_name not in self._known_contacts
            self._known_contacts[sender_name] = prefix
            self._dm_blocked.discard(sender_name)
            if is_new:
                self._save_known_contacts()
            # A paging session opened by their channel request continues by DM.
            ch_key = "ch:" + sender_name
            if ch_key in self._paging and prefix not in self._paging:
                self._paging[prefix] = self._paging.pop(ch_key)

        if text.startswith(">"):
            traffic_log.update(req, kind="data_request")
            await self._handle_app_request(text, sender_name, prefix, "dm", None, req=req, dreq=dreq)
            return

        # Admin commands (DM-only, verified by pubkey)
        if self._is_admin(prefix):
            result = await self._handle_admin(text, prefix, sender_name, arrived)
            if result is not None:
                dreq.state = "done"                  # runs once: its copies get nothing
                traffic_log.update(req, kind="admin", command=text.split(None, 1)[0].lower())
                return

        await self._respond_dm(prefix, sender_name, command, location, req=req, arrived_at=arrived, dreq=dreq)

    # Commands that answer out of the product store. help, cov and sat do not:
    # a bot that has just come up can still say what it is and what it covers.
    _STORE_COMMANDS = {"wx", "warn", "forecast", "outlook", "rain", "storm",
                       "metar", "taf", "space", "nowcast"}

    def _needs_store(self, text: str, command: str) -> bool:
        """Would this request be answered out of the products? A `>` request
        always is: the app side answers every one of them from the store."""
        return text.lstrip().startswith(">") or command in self._STORE_COMMANDS

    async def _not_ready_reply(self, dreq, prefix: str, sender_name: str, text: str,
                               req: dict | None, arrived: float) -> None:
        """The answer while the backlog is still loading: for an app, Not
        available reason 0 ("no data yet", spec 8.3); for a person, one line
        saying so. Neither spends the sender's hourly budget, and the request
        is left unanswered, so a copy of it gets the real reply once the
        products are in."""
        if text.lstrip().startswith(">"):
            traffic_log.update(req, kind="data_request")
            await self._handle_app_request(text, sender_name, prefix, "dm", None,
                                           req=req, dreq=dreq)
            return

        def prepare(r: DmReply) -> None:
            r.ev = traffic_log.record("reply_dm", text=r.text, chars=len(r.text), req=req,
                                      sender=sender_name, key=prefix, command="starting up",
                                      ok=settings.tx_enabled)

        logger.info("DM from %s while the backlog loads: answering 'starting up'", sender_name)
        reply = DmReply(key=prefix, text=NOT_READY_TEXT, kind="note", prepare=prepare)
        reply.request = dreq
        if dreq is not None:
            dreq.reply, dreq.state = reply, "not_ready"
        await self.dm_outbox.submit(reply, lambda: self.radio,
                                    not_before=arrived + settings.dm_reply_delay_s)

    async def _handle_advert(self, contact_name: str, pubkey_prefix: str) -> None:
        """Handle a new advert — only greet users who were using the channel."""
        prefix = self._normalize_key(pubkey_prefix)
        traffic_log.record("advert", sender=contact_name, key=prefix)

        # If they already DM us fine, just update the mapping — no greeting
        if contact_name in self._known_contacts:
            return

        # Remember this new contact (bounded: names are attacker-chosen)
        if contact_name and contact_name != "unknown":
            if len(self._known_contacts) > 2000:
                self._known_contacts = dict(list(self._known_contacts.items())[-1000:])
            self._known_contacts[contact_name] = prefix
            self._save_known_contacts()

        # Unblock DM if they were blocked. No re-advert and no welcome DM:
        # both are unsolicited airtime. They will DM us when they want data.
        self._dm_blocked.discard(contact_name)

    async def _handle_app_request(self, text: str, sender_name: str, sender_key: str, transport: str,
                                  hops: int | None, req: dict | None = None, dreq=None) -> None:
        """A `>` request from an app (docs/MeshWX_v5_Spec.md 8.2). `dreq`: the
        DM request it arrived as, so its copies know when the answer went out."""
        if req is None:
            req = traffic_log.record("data_request", sender=sender_name, key=sender_key if transport == "dm" else None,
                                     text=text[:40], transport=transport, hops=hops)
        # From now, not from `req`: a later copy of the request arrives with
        # the first copy's event and is as fresh on the air as the first was.
        not_before = reply_not_before(hops)
        if not self._broadcaster:
            traffic_log.record("dropped", reason="broadcasts off: no data channel", req=req, sender=sender_name)
            if dreq is not None:
                dreq.state = "done"
            return
        if dreq is not None:
            dreq.state, dreq.app_done_at = "app", None
        # The answer's own row in the feed, recorded before it goes out so the radio's delivery
        # outcome (echo, observers) lands on it; the feed used to show only the request, as if
        # the bot had never answered. A refusal turns the row into the dropped it is.
        rev = traffic_log.record("reply_data", req=req, sender=sender_name, transport="channel_data")
        outcome = await self._broadcaster.handle_request(text, sender_key, ev=rev, not_before=not_before)
        logger.info("App request from %s: %s -> %s", sender_name, text[:40], outcome)
        # "already resent": a `>part` whose every packet went out again in the
        # last 30 seconds (spec 7C.2). Nothing was sent, so the row is the
        # dropped it is, and a copy of the request is answered afresh: by then
        # the floor may have opened.
        if outcome in ("rate limited", "hourly budget spent", "already resent"):
            traffic_log.update(rev, kind="dropped", dir="out", reason=outcome, ok=False, push=True)
            if dreq is not None:
                dreq.state = "app_unanswered"
        elif outcome == "starting up":
            # Answered with Not available, on nobody's budget: a copy of the
            # request is answered again, by then perhaps with the real data.
            traffic_log.update(req, kind="data_request")
            traffic_log.update(rev, text="Not available: starting up", chars=6, ok=True, push=True)
            if dreq is not None:
                dreq.state = "not_ready"
        else:
            m = re.match(r"(\d+) packet\(s\), (\d+) B", outcome)
            traffic_log.update(rev, text=outcome, chars=int(m.group(2)) if m else None,
                               ok=m is not None, push=True)
            if dreq is not None:
                dreq.app_done_at = self._clock()

    def _is_admin(self, pubkey_prefix: str) -> bool:
        admin = settings.admin_key.lower().strip()
        return bool(admin) and pubkey_prefix.startswith(admin)

    async def _handle_admin(self, text: str, prefix: str, sender_name: str,
                            arrived: float | None = None) -> str | None:
        """Handle admin commands. Returns response string, or None if not an admin command."""
        parts = text.strip().split(None, 1)
        cmd = parts[0].lower() if parts else ""
        arg = parts[1].strip() if len(parts) > 1 else ""

        if cmd == "contacts":
            await self.radio._mc.ensure_contacts(follow=True)
            contacts = self.radio._mc._contacts or {}
            if not contacts:
                reply = "No contacts on device."
            else:
                lines = [f"{len(contacts)} contacts:"]
                for c in contacts.values():
                    name = c.get("adv_name", "?")
                    key = c.get("public_key", "")[:12]
                    lines.append(f" {name} ({key})")
                reply = "\n".join(lines)
            await self._send_dm_paginated(prefix, sender_name, reply, arrived)
            return reply

        if cmd == "remove" and arg:
            await self.radio._mc.ensure_contacts(follow=True)
            contact = self.radio._mc.get_contact_by_name(arg)
            if not contact:
                await self._send_dm(prefix, arrived,f"Contact '{arg}' not found.")
                return "not found"
            key = contact.get("public_key", "")
            name = contact.get("adv_name", "?")
            # Confirm before removing (can't DM after delete)
            is_self = self._normalize_key(key) == prefix
            if is_self:
                await self._send_dm(prefix, arrived,f"Removing: {name} (you). Re-advert to reconnect.")
            else:
                await self._send_dm(prefix, arrived,f"Removing: {name}")
            try:
                await self.radio._mc.commands.remove_contact(key)
                self._known_contacts.pop(name, None)
                logger.info("Admin %s removed contact: %s", sender_name, name)
            except Exception as e:
                logger.warning("Failed to remove %s: %s", name, e)
            return "removed"

        if cmd == "clear-contacts":
            await self.radio._mc.ensure_contacts(follow=True)
            contacts = self.radio._mc._contacts or {}
            if not contacts:
                await self._send_dm(prefix, arrived,"No contacts to remove.")
                return "empty"
            contact_list = list(contacts.values())
            await self._send_dm(prefix, arrived,f"Clearing {len(contact_list)} contacts. Re-advert to reconnect.")
            removed = 0
            for c in contact_list:
                try:
                    await self.radio._mc.commands.remove_contact(c["public_key"])
                    self._known_contacts.pop(c.get("adv_name", ""), None)
                    removed += 1
                except Exception:
                    pass
            logger.info("Admin %s cleared %d/%d contacts", sender_name, removed, len(contact_list))
            return "cleared"

        if cmd == "advert":
            await self.radio._send_advert()
            await self.radio._mc.ensure_contacts(follow=True)
            await self._send_dm(prefix, arrived,"Advert sent + contacts refreshed.")
            return "advert"

        if cmd == "refresh":
            await self.radio._mc.ensure_contacts(follow=True)
            count = len(self.radio._mc._contacts or [])
            await self._send_dm(prefix, arrived,f"Contacts refreshed: {count} contacts.")
            return "refresh"

        if cmd == "broadcast":
            if not self._broadcaster:
                await self._send_dm(prefix, arrived,"Broadcasts are off: no data channel configured.")
                return "disabled"
            await self._send_dm(prefix, arrived,"Running scheduler tick...")
            try:
                sent = await self._broadcaster.scheduler.tick()
                await self._send_dm(prefix, arrived,f"Scheduler tick sent {sent} message(s).")
            except Exception as e:
                await self._send_dm(prefix, arrived,f"Broadcast error: {e}")
            return "broadcast"

        if cmd == "warnings-broadcast":
            if not self._broadcaster:
                await self._send_dm(prefix, arrived,"Broadcasts are off: no data channel configured.")
                return "disabled"
            try:
                sent = await self._broadcaster.scheduler.run_job_now("warnings")
                await self._send_dm(prefix, arrived,f"Sent {sent} warning message(s).")
            except Exception as e:
                await self._send_dm(prefix, arrived,f"Warning broadcast error: {e}")
            return "warnings-broadcast"

        if cmd == "test-data-ch":
            ch = self.radio.data_channel_idx
            if ch is None:
                await self._send_dm(prefix, arrived,"No data channel configured.")
                return "no ch"
            if not settings.tx_enabled:
                await self._send_dm(prefix, arrived,"TX disabled — test ping suppressed.")
                return "tx-disabled"
            await self.radio._mc.commands.send_chan_msg(ch, "test ping")
            await self._send_dm(prefix, arrived,f"Sent text test on ch {ch}.")
            return "test"

        if cmd == "admin":
            reply = (
                "Admin commands (DM only):\n"
                "contacts - list contacts\n"
                "remove <name> - remove contact\n"
                "clear-contacts - remove all\n"
                "advert - send advert now\n"
                "refresh - reload contacts\n"
                "broadcast - run a scheduler tick now\n"
                "warnings-broadcast - send warnings"
            )
            await self._send_dm_paginated(prefix, sender_name, reply, arrived)
            return reply

        return None  # Not an admin command, fall through to normal handling

    async def _send_dm_paginated(self, pubkey: str, sender_name: str, text: str,
                                 arrived: float | None = None) -> None:
        """Send a long admin reply: page 1 now, the rest on 'more'."""
        pages = self._start_session(self._normalize_key(pubkey), "admin", text)
        await self._send_dm(pubkey, arrived, pages[0])

    async def _send_dm(self, pubkey: str, arrived: float | None, text: str) -> bool:
        """An admin reply: behind the contact's other replies and tried like
        them, no earlier than MCW_DM_REPLY_DELAY_S after its request arrived."""
        at = self._clock() if arrived is None else arrived
        return await self.dm_outbox.submit(DmReply(key=pubkey, text=text, kind="admin"), lambda: self.radio,
                                           not_before=at + settings.dm_reply_delay_s)

    # -- Replies and paging --
    #
    # Every reply is rendered in full and cut into numbered pages at the
    # message budget (core/pages.py). Page 1 answers the request; "more"
    # from the same person sends the next page, on whichever transport the
    # "more" arrived. A person is their public key when we know it, else
    # their channel name; a session opened on the channel moves to the key
    # the first time they DM us.

    PAGE_SESSION_TTL_S = 900
    PAGE_SESSIONS_MAX = 500

    def page_budget(self) -> int:
        """Pages fit both transports: the DM budget (155) and the channel
        budget (153 minus our name), never more than MAX_DM."""
        try:
            return min(MAX_DM, int(self.radio.channel_text_budget()))
        except Exception:
            return MAX_DM

    def person_key(self, sender_name: str, pubkey: str | None = None) -> str:
        if pubkey:
            return self._normalize_key(pubkey)
        known = self._known_contacts.get(sender_name)
        if known:
            return self._normalize_key(known)
        contact = self.radio.find_contact_by_name(sender_name) if hasattr(self.radio, "find_contact_by_name") else None
        if contact and contact.get("public_key"):
            return self._normalize_key(contact["public_key"])
        return "ch:" + sender_name

    def _prune_sessions(self, now: float) -> None:
        cutoff = now - self.PAGE_SESSION_TTL_S
        if any(v["ts"] <= cutoff for v in self._paging.values()) or len(self._paging) > self.PAGE_SESSIONS_MAX:
            live = sorted(((v["ts"], k) for k, v in self._paging.items() if v["ts"] > cutoff), reverse=True)
            self._paging = {k: self._paging[k] for _, k in live[: self.PAGE_SESSIONS_MAX]}

    def _pages(self, response: str) -> list[str]:
        """Pages fit both transports: a DM's 156 UTF-8 bytes and the bytes of
        a channel message whose echo the node can report."""
        try:
            max_bytes = min(DM_MAX_BYTES, int(self.radio.channel_text_budget()))
        except Exception:
            max_bytes = DM_MAX_BYTES
        return split_pages(response, self.page_budget(), max_bytes=max_bytes)

    def _start_session(self, key: str, command: str, response: str) -> list[str]:
        pages = self._pages(response)
        self._set_session(key, command, pages)
        return pages

    def _set_session(self, key: str, command: str, pages: list[str]) -> dict:
        now = time.time()
        self._prune_sessions(now)
        session = {"pages": pages, "next": 1, "ts": now, "command": command, "replies": {}, "confirmed": set()}
        self._paging[key] = session
        return session

    def reply_chunk(self, command: str, location: str, sender_key: str,
                    dm: bool = False) -> tuple[str | None, bool]:
        """The one message this person gets now, and whether a 'more' would
        fetch another. Shared by the DM path, channel mode, the CLI and the
        portal console, so they all page the same way. `dm`: the reply goes
        by DM (help then leaves out "DM me")."""
        now = time.time()
        self._prune_sessions(now)
        if command == "more":
            session = self._paging.get(sender_key)
            if not session:
                return "Nothing to continue. Send a command first.", False
            if session["next"] >= len(session["pages"]):
                return f"That was the whole reply to '{session['command']}'. Send a new command.", False
            page = session["pages"][session["next"]]
            session["next"] += 1
            session["ts"] = now
            return page, session["next"] < len(session["pages"])
        response = HELP_TEXT_DM if dm and command == "help" else self._process_command(command, location)
        if not response:
            return None, False
        pages = self._start_session(sender_key, (command + " " + location).strip(), response)
        return pages[0], len(pages) > 1

    # A page sent by DM counts as delivered once the sender's ACK confirms it.
    # A page sent any other way (channel, console) cannot be confirmed and
    # counts as delivered once sent.

    @staticmethod
    def _track_page(session: dict, idx: int, reply: DmReply) -> None:
        session.setdefault("replies", {})[idx] = reply
        session["last"] = reply                      # the page a new-timestamp `more` is judged by
        session["next"] = max(session["next"], idx + 1)
        session["ts"] = time.time()
        reply.on_confirmed.append(lambda r, s=session, i=idx: s.setdefault("confirmed", set()).add(i))

    @staticmethod
    def _first_unconfirmed(session: dict) -> int | None:
        replies, confirmed = session.get("replies", {}), session.get("confirmed", set())
        for idx in range(len(session["pages"])):
            if idx in confirmed or (idx not in replies and idx < session["next"]):
                continue
            return idx
        return None

    def _dm_more(self, person: str, reply: DmReply) -> str:
        """`more` by DM: the first page the sender has not confirmed, chosen when
        the reply is about to go out, not when `more` arrived. It may repeat a
        page whose ACK was lost; it never skips one."""
        self._prune_sessions(time.time())
        session = self._paging.get(person)
        if not session:
            reply.kind = "note"
            return "Nothing to continue. Send a command first."
        idx = self._first_unconfirmed(session)
        if idx is None:
            reply.kind = "note"
            return f"That was the whole reply to '{session['command']}'. Send a new command."
        self._track_page(session, idx, reply)
        return session["pages"][idx]

    async def _respond_dm(self, pubkey_prefix: str, sender_name: str, command: str, location: str,
                          req: dict | None = None, arrived_at: float | None = None, dreq=None) -> DmReply | None:
        """Send the reply as a DM: behind this contact's earlier replies, no
        earlier than MCW_DM_REPLY_DELAY_S after the request arrived, tried
        until the sender's ACK confirms it (meshcore/delivery.py DmOutbox)."""
        person = self.person_key(sender_name, pubkey_prefix)
        arrived = self._clock() if arrived_at is None else arrived_at
        pages: list[str] | None = None

        def prepare(r: DmReply) -> None:             # just before its first try
            if pages is not None:
                self._track_page(self._set_session(person, (command + " " + location).strip(), pages), 0, r)
            r.ev = traffic_log.record("reply_dm", text=r.text, chars=len(r.text), req=req, sender=sender_name,
                                      key=pubkey_prefix, command=command, location=location, ok=settings.tx_enabled)

        if command == "more":
            reply = DmReply(key=pubkey_prefix, kind="page", build=lambda r: self._dm_more(person, r), prepare=prepare)
        else:
            response = HELP_TEXT_DM if command == "help" else self._process_command(command, location)
            if not response:
                traffic_log.record("dropped", reason="nothing to say", req=req, sender=sender_name, key=pubkey_prefix)
                if dreq is not None:
                    dreq.state = "done"
                return None
            pages = self._pages(response)
            reply = DmReply(key=pubkey_prefix, text=pages[0], prepare=prepare)
        reply.request = dreq
        if dreq is not None:
            dreq.state, dreq.reply = "replied", reply
        if await self.dm_outbox.submit(reply, lambda: self.radio, not_before=arrived + settings.dm_reply_delay_s):
            logger.info("Response to %s (DM): %s", sender_name, reply.text.replace("\n", " | "))
        elif reply.state == "dropped":
            traffic_log.record("dropped", reason="reply queue full", req=req, sender=sender_name, key=pubkey_prefix)
        elif reply.state == "failed" and not reply.tries:
            # DM refused: drop it. The user will retry; no channel fallback,
            # no advert. Forget the stale mapping so a fresh advert re-learns it.
            traffic_log.update(reply.ev, kind="dm_failed", ok=False)
            logger.info("DM to %s failed — forgetting the path; the next channel command gets a channel reply", sender_name)
            self._dm_blocked.add(sender_name)
            self._known_contacts.pop(sender_name, None)
        return reply

    # -- Helpers --

    @staticmethod
    def _normalize_key(key: str) -> str:
        """Normalize a pubkey to 12-char prefix for consistent session keying."""
        return key[:12].lower()

    def _resolve_sender_key(self, sender_name: str) -> str | None:
        """Try to find a pubkey prefix for a channel message sender so we can DM them."""
        # Don't try DM for contacts where it has previously failed
        if sender_name in self._dm_blocked:
            return None
        # Check our learned contacts first
        if sender_name in self._known_contacts:
            return self._known_contacts[sender_name]
        # Try the device's contact list
        contact = self.radio.find_contact_by_name(sender_name)
        if contact:
            pubkey = contact.get("public_key", "")
            if pubkey:
                prefix = self._normalize_key(pubkey)
                self._known_contacts[sender_name] = prefix
                self._save_known_contacts()
                return prefix
        return None

    def _load_known_contacts(self) -> None:
        try:
            if self._CONTACTS_FILE.exists():
                self._known_contacts = json.loads(self._CONTACTS_FILE.read_text())
                logger.info("Loaded %d known contacts from disk", len(self._known_contacts))
        except Exception:
            logger.debug("Could not load known contacts")

    def _save_known_contacts(self) -> None:
        try:
            self._CONTACTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            self._CONTACTS_FILE.write_text(json.dumps(self._known_contacts))
        except Exception:
            logger.debug("Could not save known contacts")

    # Reply budgets: one every 5 s per sender, at most this many per sender
    # and in total per hour. Every reply costs airtime; a script hammering
    # the channel must not be able to spend the mesh's. The defaults; the
    # checks read settings.text_replies_per_sender_per_hour and
    # settings.text_replies_per_hour, which the portal sets live.
    REPLIES_PER_SENDER_PER_HOUR = 40
    REPLIES_PER_HOUR = 400

    def _rate_check(self, sender_key: str, follow_up: bool = False, copy: bool = False) -> bool:
        """One reply per sender per 5 s, plus hourly budgets. A 'more' is a
        follow-up to a reply we just sent and only needs 2 s of spacing;
        it still counts against the hourly budgets. A `copy` of a DM request
        that has to be sent (its first was dropped here, or its reply failed)
        skips the spacing and leaves it untouched, but spends the hourly
        budgets, which can still refuse it. A copy that gets nothing never
        comes here."""
        now = self._clock()
        if not copy:
            last = self._rate_limit.get(sender_key, 0)
            if now - last < (2 if follow_up else 5):
                return False
        hour_ago = now - 3600
        hist = [ts for ts in self._reply_history.get(sender_key, []) if ts > hour_ago]
        self._reply_history[sender_key] = hist
        if len(hist) >= settings.text_replies_per_sender_per_hour:
            logger.warning("Rate limit: %s has had %d replies this hour — ignoring", sender_key[:20], len(hist))
            return False
        self._all_replies = [ts for ts in self._all_replies if ts > hour_ago]
        if len(self._all_replies) >= settings.text_replies_per_hour:
            logger.warning("Rate limit: %d replies this hour overall — ignoring", len(self._all_replies))
            return False
        if not copy:
            self._rate_limit[sender_key] = now
        hist.append(now)
        self._all_replies.append(now)
        # Bounded state: a flood of made-up sender names must not grow memory.
        if len(self._rate_limit) > 5000:
            self._rate_limit = {k: v for k, v in self._rate_limit.items() if now - v < 3600}
            self._reply_history = {k: v for k, v in self._reply_history.items() if v and v[-1] > hour_ago}
            self._channel_reply_by_sender = {k: v for k, v in self._channel_reply_by_sender.items() if now - v < 3600}
        return True

    async def _parse(self, text: str) -> tuple[str, str]:
        text = text[:200]
        text = "".join(c for c in text if c.isprintable() or c in "\n ")
        intent = await parse_intent(text)
        command = intent["command"]
        location = intent["location"]
        # "warn more", "wx more": the user wants the next page, not Skidmore, TX.
        if location.strip().lower() in ("more", "next") and command != "more":
            command, location = "more", ""
        location = "".join(c for c in location if c.isalnum() or c in " ,.-'")[:50]
        return command, location

    @staticmethod
    def _to_state_code(text: str) -> str | None:
        t = text.strip()
        if len(t) == 2 and t.upper() in VALID_STATES:
            return t.upper()
        name = t.lower()
        if name in STATE_NAMES:
            return STATE_NAMES[name]
        return None

    # -- Place replies via the core service layer -----------------------------
    #
    # wx / warn / forecast for a place all go through core.services so the
    # text a human reads and the bytes an app decodes come from the same
    # parse of the same products.

    def _place_reply(self, kind: str, location: str) -> str:
        from meshcore_weather.core import render_text, services
        loc = resolver.resolve(location)
        if not loc:
            return f"Unknown {'ZIP' if zip_code(location) else 'location'}: {location}"
        if kind == "warn":
            return render_text.warnings(loc, services.warnings_for(self.store, loc))
        if kind == "forecast":
            return render_text.forecast(loc, services.forecast_for(self.store, loc))
        if kind == "outlook":
            return render_text.outlook(loc, services.outlook_for(self.store, loc))
        if kind == "metar":
            return render_text.raw_metar(loc, services.raw_metar_for(self.store, loc))
        if kind == "taf":
            return render_text.taf(loc, services.taf_for(self.store, loc))
        ob = services.observation_for(self.store, loc)
        ws = services.warnings_for(self.store, loc)
        fc = services.forecast_for(self.store, loc)
        return render_text.summary(loc, ob, ws, fc)

    def _radar_reply(self, location: str) -> str:
        """radar [place]: the newest radar picture in words (spec 7D). The
        bot's home when no place is given."""
        from datetime import datetime, timezone
        from meshcore_weather.core import render_text
        from meshcore_weather.radar import describe, service as radar_service
        radar = radar_service.shared()
        if not radar.available:
            return "No radar on this bot: the pictures come down the satellite dish, and it has none"
        target = location or (settings.home_cities.split(",")[0].strip() if settings.home_cities else "")
        loc = resolver.resolve(target) if target else None
        if not loc or loc.get("lat") is None:
            return f"Unknown {'ZIP' if zip_code(location) else 'location'}: {location}" if location \
                else "Usage: radar <city ST>"
        lat, lon = float(loc["lat"]), float(loc["lon"])
        found = radar.tile_for(lat, lon, 0)
        if found is None:
            return render_text.radar(loc, datetime.now(timezone.utc), None)
        tile, picture, _frame = found
        return render_text.radar(loc, picture.taken, describe(tile, lat, lon))

    def _area_reply(self, kind: str, location: str) -> str:
        """rain / storm: for a state code, or the state of a place, or the
        bot's home state when nothing is given."""
        from meshcore_weather.core import render_text, services
        state = self._to_state_code(location) if location else None
        label = ""
        if state is None:
            target = location or (settings.home_cities.split(",")[0].strip() if settings.home_cities else "")
            loc = resolver.resolve(target) if target else None
            if not loc or not loc.get("zones"):
                if not location:
                    return "Usage: rain <ST or city ST>"
                return f"Unknown {'ZIP' if zip_code(location) else 'location'}: {location}"
            state = loc["zones"][0][:2]
            label = f"in {state}"
        else:
            label = f"in {state}"
        if kind == "rain":
            return render_text.rain(label, services.rain_for(self.store, state=state))
        return render_text.storm_reports(label, services.storm_reports_for(self.store, state=state), state=state)

    def _coverage(self):
        """What this bot covers. The scheduler's Coverage when one is running
        (already built), else built once from the env config and kept:
        resolving it walks the zone polygons, which no DM should pay for
        twice."""
        if self._broadcaster is not None:
            return self._broadcaster.coverage
        if self._coverage_cache is None:
            from meshcore_weather.protocol.coverage import Coverage
            self._coverage_cache = Coverage.from_config()
        return self._coverage_cache

    def _digest_interval_minutes(self) -> int:
        """How often the active-warning list goes out, from the live schedule
        when there is one. 0 = the digest job is switched off."""
        try:
            job = self._broadcaster.scheduler.current_config().get_job("digest")
        except Exception:
            return 180
        if job is None:
            return 180
        return job.interval_minutes if job.enabled else 0

    def _coverage_reply(self) -> str:
        """The `cov` reply: the facts the Coverage message carries (spec 7A),
        in words."""
        from meshcore_weather.core import render_text
        from meshcore_weather.protocol import v5_builders as b
        facts = b.coverage_facts(self._coverage(), resolver.home(),
                                 float(settings.home_radius_km or 0))
        return render_text.coverage(facts, self._digest_interval_minutes())

    def _process_command(self, command: str, location: str) -> str | None:
        if command == "help":
            return HELP_TEXT

        if command == "sat":
            if self._sdr_monitor is None:
                return "No satellite receiver on this bot: its EMWIN comes over the internet"
            line = self._sdr_monitor.report(emwin_mtime=getattr(self.emwin, "newest_mtime", None))
            since = getattr(self.emwin, "fallback_since", None)
            if since is not None:
                # The dish is quiet and the bot is on NOAA's internet feed:
                # the one thing a person asking `sat` most needs to know.
                line += f". Internet backup on since {since.strftime('%H:%MZ')}"
            return line

        if command == "cov":
            return self._coverage_reply()

        # Nothing is read out of a store that is still loading: an empty one
        # would answer "no warnings" and "no data for that place", which the
        # asker would take for the truth. Every transport passes through here
        # (DM, channel, the portal console and the CLI), so they all say it.
        if command in self._STORE_COMMANDS and not self.store_ready:
            return NOT_READY_TEXT

        from meshcore_weather.core import overview

        if command == "wx":
            if not location:
                return overview.national(self.store)
            state = self._to_state_code(location)
            if state:
                return overview.state(self.store, state)
            return self._place_reply("wx", location)

        if command == "warn":
            if not location:
                return overview.warnings_summary(self.store)
            state = self._to_state_code(location)
            if state:
                return overview.warnings_in_state(self.store, state)
            return self._place_reply("warn", location)

        if command == "forecast":
            if not location:
                return "Usage: forecast <city ST>"
            return self._place_reply("forecast", location)

        if command == "outlook":
            if not location:
                return "Usage: outlook <city ST>"
            return self._place_reply("outlook", location)

        if command == "rain":
            return self._area_reply("rain", location)

        if command == "radar":
            return self._radar_reply(location)

        if command == "storm":
            return self._area_reply("storm", location)

        if command == "metar":
            if not location:
                return "Usage: metar <ICAO or city ST>"
            return self._place_reply("metar", location)

        if command == "taf":
            if not location:
                return "Usage: taf <ICAO or city ST>"
            return self._place_reply("taf", location)

        if command == "space":
            from meshcore_weather.core import space_weather
            return space_weather.render(space_weather.space_weather_for(self.store))

        return None


async def run(bot: WeatherBot) -> None:
    """Start the bot, wait for a signal, stop it.

    SIGTERM lands here whenever it arrives — during the start-up, which now
    ends in seconds but used to take a minute and a half, or years into a
    run. The bot is then stopped from a coroutine that is allowed to finish,
    and this returns: no loop.stop() under a pending future (the
    "RuntimeError: Event loop stopped before Future completed" every systemd
    stop used to end with), and nothing of ours left pending.
    """
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signalled, bot, sig)
    started = asyncio.ensure_future(bot.start())
    exiting = asyncio.ensure_future(bot.wait_for_exit())
    try:
        await asyncio.wait({started, exiting}, return_when=asyncio.FIRST_COMPLETED)
        if started.done():
            started.result()             # a start-up that failed is still an error
            await exiting
        else:
            await _cancel(started)       # signalled mid-start: stop() clears up what was built
    finally:
        await _cancel(exiting)
        await bot.stop()


def _signalled(bot: WeatherBot, sig: signal.Signals) -> None:
    logger.info("Received signal %s, shutting down...", sig.name)
    bot.request_stop()


def main():
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    # Library chatter that would drown the console: one HTTP line per poll.
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    bot = WeatherBot()
    try:
        # asyncio.run and not a loop of our own: it cancels and awaits
        # whatever is still running when run() returns (a DM reply waiting on
        # an ACK, a repeater echo window), so no task is destroyed pending.
        asyncio.run(run(bot))
    except KeyboardInterrupt:
        pass
    except Exception:
        logger.exception("Weather bot stopped on an error")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
