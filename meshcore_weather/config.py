"""Application configuration via environment variables and .env file.

Besides the settings themselves, the checks a new operator's mistakes must
meet before they reach the air (`meshcore-weather --check` runs all of
them, and the bot logs the same ones at start): the radio region's band,
the node name convention, the admin key, the portal's allowed hosts and
the time zone taken from the home city.
"""

import re
from pathlib import Path

from pydantic import PrivateAttr, model_validator
from pydantic_settings import BaseSettings

# Where the bot may transmit, per MCW_RADIO_REGION: the licence-free band the
# region's MeshCore presets sit in (MHz). A frequency outside it is refused,
# and a node found on one at start has its transmit switched off. US: FCC
# 15.247 902-928 MHz. EU: the 863-870 MHz SRD band (MeshCore's 869.525 MHz
# preset is in its 869.4-869.65 MHz sub-band).
REGION_BANDS: dict[str, tuple[float, float]] = {
    "US": (902.0, 928.0),
    "EU": (863.0, 870.0),
}

# WX-<IATA>: every weather bot adverts under this name, and apps find bots by
# the WX- prefix. 2-8 capitals or digits after it.
NODE_NAME_RE = re.compile(r"^WX-[A-Z0-9]{2,8}$")

# Shorter admin prefixes are refused: 8 hex characters is a 32-bit search for
# anyone willing to grind keypairs, and the DM sender is only ever 12.
ADMIN_KEY_MIN_HEX = 8
ADMIN_KEY_MAX_HEX = 12

# Always answered by the portal's Host check (portal/server.py), whatever
# MCW_PORTAL_ALLOWED_HOSTS says: the Pi's own dashboard and an SSH tunnel.
PORTAL_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "[::1]", "::1")

# States whose counties do not all keep the state's main time zone: the
# zone filled in from the home city is a guess there, and --check says so.
SPLIT_TZ_STATES = {"AK", "AZ", "FL", "ID", "IN", "KS", "KY", "MI", "ND", "NE", "NV", "OR", "SD", "TN", "TX"}


def _csv(value: str) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def admin_key_problem(key: str) -> str | None:
    """Why MCW_ADMIN_KEY cannot be used, or None (empty is fine: no admin)."""
    key = (key or "").strip()
    if not key:
        return None
    if not re.fullmatch(r"[0-9a-fA-F]+", key):
        return "it must be hex, the first 12 characters of your public key"
    if len(key) < ADMIN_KEY_MIN_HEX:
        return (f"{len(key)} hex characters is too short to identify anyone; use at least "
                f"{ADMIN_KEY_MIN_HEX}, ideally the first {ADMIN_KEY_MAX_HEX} of your public key")
    return None


def node_name_problem(name: str | None) -> str | None:
    """Why a node name breaks the WX-<IATA> convention, or None."""
    if not name:
        return "the node has no name"
    if NODE_NAME_RE.match(name):
        return None
    return (f"node name {name!r} does not follow the WX-<IATA> convention (e.g. WX-AUS): "
            "apps find weather bots by it, and other bots ignore WX- names on the channel")


def iata_from_name(name: str | None) -> str | None:
    """'WX-AUS' -> 'AUS'; None for a name off the convention."""
    return name[3:] if name and NODE_NAME_RE.match(name) else None


def region_band(region: str | None = None) -> tuple[float, float] | None:
    """The (low, high) MHz band MCW_RADIO_REGION allows, or None when unknown."""
    return REGION_BANDS.get((region if region is not None else settings.radio_region).strip().upper())


def frequency_problem(freq_mhz: float | None, bw_khz: float | None = None,
                      region: str | None = None) -> str | None:
    """Why the radio may not transmit on this frequency in the configured
    region, or None. The whole channel (centre +/- half the bandwidth) must
    sit inside the band."""
    region = (region if region is not None else settings.radio_region).strip().upper()
    band = REGION_BANDS.get(region)
    if band is None:
        return (f"MCW_RADIO_REGION={region or '(empty)'} is not a region the bot knows "
                f"({', '.join(sorted(REGION_BANDS))}); every frequency is refused")
    if freq_mhz is None:
        return None
    half = (float(bw_khz or 0) / 1000.0) / 2
    lo, hi = band
    if float(freq_mhz) - half < lo or float(freq_mhz) + half > hi:
        return (f"{float(freq_mhz):g} MHz is outside the {region} band {lo:g}-{hi:g} MHz "
                f"(MCW_RADIO_REGION={region})")
    return None


def portal_allowed_hosts() -> list[str]:
    """Host header values the portal answers: loopback always, the bind
    address when it is a specific one, and MCW_PORTAL_ALLOWED_HOSTS."""
    out = list(PORTAL_LOOPBACK_HOSTS)
    bind = (settings.portal_host or "").strip()
    if bind and bind not in ("0.0.0.0", "::", "[::]"):
        out.append(bind)
    out.extend(h.lower() for h in _csv(settings.portal_allowed_hosts))
    seen: set[str] = set()
    return [h for h in out if not (h in seen or seen.add(h))]


# -- Time zone ----------------------------------------------------------------------
#
# MCW_TIMEZONE used to default to America/Chicago, which made every new bot
# outside Central time print the wrong clock. Left empty it is now taken from
# the home city's state at start; render_text reads settings.timezone, so it
# is filled in there.

_tz_from_home = False   # settings.timezone was filled in here, not set by the operator


def home_timezone() -> tuple[str | None, str]:
    """(IANA zone of the first home city's state, how it was found)."""
    first = (_csv(settings.home_cities) or [""])[0]
    if not first:
        return None, "MCW_HOME_CITIES is empty"
    from meshcore_weather.core.render_text import _STATE_TZ
    from meshcore_weather.geodata import resolver
    loc = resolver.resolve(first)
    zones = (loc or {}).get("zones") or []
    if not zones:
        return None, f"the home city {first!r} does not resolve"
    state = zones[0][:2]
    name = _STATE_TZ.get(state)
    if not name:
        return None, f"no time zone known for {state}"
    return name, f"from the home city's state ({state})"


def fill_timezone() -> tuple[str, str]:
    """Fill settings.timezone from the home city when MCW_TIMEZONE is empty
    (again after the home city changed). Returns (zone or "", source)."""
    global _tz_from_home
    if settings.timezone and not _tz_from_home:
        return settings.timezone, "MCW_TIMEZONE"
    name, how = home_timezone()
    settings.timezone = name or ""
    _tz_from_home = bool(name)
    return settings.timezone, how


def timezone_set_by_operator() -> None:
    """MCW_TIMEZONE was set (the portal): a home city change no longer moves it."""
    global _tz_from_home
    _tz_from_home = False


class Settings(BaseSettings):
    model_config = {
        "env_prefix": "MCW_",
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    # Meshcore serial connection
    serial_port: str = "/dev/cu.usbserial-0001"
    serial_baud: int = 115200
    meshcore_channel: str = "#meshwx"  # request channel: one name for every bot, everywhere
    # Operational status lines (status_channel.py): lock lost or back, the
    # internet fill filling in or not, products running hours behind, the Pi's
    # dashboard, disk or temperature. One short line per change, on a public
    # hashtag channel anyone can join by name. Never the request channel.
    # Empty = no status lines.
    status_channel: str = ""

    # EMWIN data source
    emwin_source: str = "internet"  # "internet" or "sdr"
    emwin_poll_interval: int = 60   # seconds between data refreshes
    # "sdr": goesproc's emwin output tree (YYYY-MM-DD/ dirs of .TXT files)
    sdr_emwin_dir: str = "~/goes-images/emwin"
    sdr_poll_interval: int = 30     # seconds between directory scans
    # The internet fill (emwin/fill.py), the feed's one backup: a product the
    # feed (the dish, or NOAA's bundles) has not delivered within its grace of
    # being issued is taken from NWS over the internet instead. Text from
    # api.weather.gov, airport reports and forecasts from NWS's tgftp feeds,
    # radar from radar.weather.gov. It replaced, on 2026-10-19, the dish's
    # NOAA-bundle backup (the uplink's own queue, as late as the dish when NOAA
    # fell behind) and the METAR feed's on/off switch. False = never.
    fill_enabled: bool = True
    fill_grace_warning_min: int = 2      # warnings, watches and statements
    fill_grace_min: int = 15             # everything else, airport reports and forecasts too
    fill_radar_grace_min: int = 20       # a region's newest picture older than this: the web's
    fill_poll_interval: int = 60         # seconds between listings of what NWS issued
    fill_api_url: str = "https://api.weather.gov"
    fill_radar_url: str = "https://radar.weather.gov/ridge/standard"
    nws_metar_url: str = "https://tgftp.nws.noaa.gov/SL.us008001/DF.an/DC.sflnd/DS.metar/"
    nws_taf_url: str = "https://tgftp.nws.noaa.gov/SL.us008001/DF.an/DC.sflnd/DS.tafst/"
    # Radar pictures (spec 13): a directory of EMWIN `*-RAD*.GIF` under YYYY-MM-DD/.
    # Empty means the dish's own EMWIN directory when the source is "sdr", and
    # no radar at all otherwise: the internet bundle carries no images.
    radar_dir: str = ""
    # goestools dashboard (signal stats, pointing mode): the address the bot
    # polls (/api/state every 10 s) and posts mode changes to. On the Pi that
    # is the dashboard itself on localhost, never its public hostname: a poll
    # that leaves the house and comes back through Cloudflare fails with it.
    sdr_dashboard_url: str = "http://127.0.0.1:8080"
    # ... and the address a person is given for it (the portal's link, the
    # public bundle): the public hostname when the dashboard has one. Empty =
    # the same as sdr_dashboard_url.
    sdr_dashboard_public_url: str = ""
    # How often the bot floods an advert so phones can DM it (hours)
    advert_interval_hours: int = 6
    # How text replies go out:
    #   dm       DM when we know the sender; a stranger who is close (few hops)
    #            gets one reply on our channel and an advert so the next
    #            exchange can be a DM
    #   channel  always reply on the channel (flood) — for testing/coverage
    #            demos; every repeater in range carries every reply
    #   dm_only  DM or silence, never a channel reply
    reply_mode: str = "dm"
    channel_reply_max_hops: int = 2       # strangers further than this get no channel reply
    peer_bot_prefix: str = "WX-"          # other weather bots advert with this name prefix
    # The node's contact table is what makes DMs possible: a person the node
    # has not stored cannot be DMed. The firmware reports its capacity (350 on
    # a Heltec V3); contact_slots is only the fallback when it does not.
    # Housekeeping removes repeaters, rooms and sensors from it (a DM path is
    # a list of repeater hashes, not contacts) and, when the people alone
    # approach the limit, the ones heard longest ago. The admin key and
    # peer bots are never removed. Off = the firmware's own behaviour.
    contact_housekeeping: bool = True
    contact_slots: int = 100              # fallback when DEVICE_INFO has no max_contacts
    contact_keep_free: int = 10           # room left for newcomers after a housekeeping run
    # Delivery: the node reports every packet it hears, including a repeater's
    # copy of our own, so a reply with no echo inside the window is sent
    # again (byte-identical: nodes that got it drop it, nodes that missed it
    # take it). DMs use the recipient's ACK instead. 0 = measure only.
    retransmit_max: int = 1
    # Observed echo delays on the Austin mesh run to about 4 s on a quiet
    # loop, so 5 s left no margin and a third of the replies were flooded
    # twice for nothing. The window is also extended by whatever time the
    # event loop spent blocked (delivery.LoopLag).
    echo_window_s: float = 8.0
    retransmit_per_hour: int = 30
    mesh_quiet_s: int = 600               # no repeat heard from anyone for this long: don't bother
    # What the bot spends answering, and how often. Set on the portal (Text bot,
    # Limits and cooldowns) and applied live. On 2026-10-01 the app budget, then
    # 60 packets, ran out at 13:35 and requests went unanswered for half an
    # hour, and the 5 s gap dropped requests the apps had spaced 5 s apart but
    # the mesh delivered 4 s apart; both were raised.
    app_packets_per_hour: int = 240       # app answers, every sender together; then "busy"
    app_sender_gap_s: float = 2.0         # one app request per radio this often
    sweep_window_s: int = 300             # alert map: the same ground once per window, whoever asks
    radar_window_s: int = 300             # radar: the same tile of one picture once per window
    part_resend_floor_s: int = 30         # a missing packet resent at most this often, whoever asks
    text_replies_per_sender_per_hour: int = 40
    text_replies_per_hour: int = 400
    stranger_replies_per_hour: int = 12   # reply mode dm: channel replies to people with no DM path
    stranger_reply_gap_s: int = 600       # ... and one per person this often
    # Optional CoreScope instance (internet): "stats" annotates each reply with
    # who heard it; "decide" also skips a retransmit the mesh observed. Empty = off.
    scope_url: str = ""
    scope_mode: str = "stats"
    # Observers that heard a REPEATED copy before a resend is skipped. One is
    # proof enough: on 2026-10-01 a threshold of two sent 8 packets again
    # that a repeater had already carried.
    scope_min_observers: int = 1
    # DM requests. A sender's app sends a DM again when it hears no ACK, with
    # the same text and the same or a new timestamp. Such a copy of a request
    # is never answered twice: same sender, timestamp and text within
    # dm_copy_retain_s, or same sender and text within dm_copy_window_s of
    # the request's first copy. After that the same text is a new request.
    dm_copy_window_s: int = 120
    dm_copy_retain_s: int = 1800
    # A DM reply leaves no earlier than this after its request arrived, so
    # the node's own ACK of the request clears the first repeater first.
    dm_reply_delay_s: float = 2.0
    # An answer to a request that came through repeaters waits this long, plus
    # up to half as much again at random, so it does not go out while the
    # repeaters are still passing the request on (main.reply_not_before).
    # A request heard direct is answered at once. 0 = never wait.
    relayed_reply_delay_s: float = 1.0
    # Radio hardware swaps. The bot keeps a profile of its node (identity key,
    # name, position, LoRa parameters, TX power, contacts) in
    # data/node_profile.json. When a different radio answers on the port:
    #   manual  (default) nothing is written: the portal shows the radio under
    #           Radio > Hardware and waits for "Adopt" (or "start a new profile")
    #   auto    write the profile onto it at once (import the key, apply the
    #           settings, restore the contacts, reboot), no questions asked
    #   off     never adopt (the profile is still kept up to date)
    # Until a foreign radio is adopted the bot holds its adverts, so phones do
    # not learn a stranger's key under the bot's name.
    radio_adopt: str = "manual"
    # Health: nothing heard from anyone for this long means the receiver is deaf
    radio_rx_silent_min: int = 30
    # Initial load uses 1-hour bundle for coverage, then polls 2-minute bundle
    emwin_base_url: str = "https://tgftp.nws.noaa.gov/SL.us008001/CU.EMWIN/DF.xt/DC.gsatR/OPS/txthrs01.zip"
    emwin_poll_url: str = "https://tgftp.nws.noaa.gov/SL.us008001/CU.EMWIN/DF.xt/DC.gsatR/OPS/txtmin02.zip"
    emwin_max_age_hours: int = 12  # Expire products older than this

    # Data storage
    data_dir: Path = Path("data")

    # Data channel: the binary datagrams for the app (GRP_DATA). Empty = off.
    # It may name the same channel as meshcore_channel, and in v5 it does:
    # one #meshwx slot carries both the text conversation and the datagrams.
    meshwx_channel: str = "#meshwx"
    meshwx_refresh_cooldown: int = 300    # min seconds between app refreshes per region

    # Coverage targeting — bot broadcasts only data affecting these areas.
    # Comma-separated lists, all additive (union). Coverage fails closed
    # (protocol/coverage.py): a home city that does not resolve, or a bare
    # name that is in several states, is an error, and with no coverage at
    # all the scheduled warnings, digest and observations send nothing.
    home_cities: str = ""  # e.g. "Austin TX,San Antonio TX,Dallas TX"
    # Coverage radius (km) around the FIRST home city. The bot covers every
    # public forecast zone whose polygon lies within this circle, plus any
    # extra cities/states/WFOs listed. 0 disables the radius.
    home_radius_km: int = 120
    home_states: str = ""  # e.g. "TX,OK"
    home_wfos: str = ""    # e.g. "EWX,FWD,HGX"
    # "national" = no area filter: the scheduled broadcasts carry every
    # warning the feed has. The only way to get that; empty = the home area.
    coverage: str = ""
    # Ceiling on what the scheduled jobs put on the air, every job together
    # (schedule/scheduler.py). Tornado, severe thunderstorm, flash flood and
    # extreme wind warnings and their one repeat always go out and count;
    # past the ceiling everything else waits for the hour to free up.
    scheduled_packets_per_hour: int = 120

    # Local web portal. No login: 127.0.0.1 and an SSH tunnel, or a LAN
    # address you trust. The Docker image binds 0.0.0.0 inside the container
    # and docker-compose publishes it on the host's 127.0.0.1 only.
    portal_enabled: bool = False
    portal_host: str = "127.0.0.1"
    portal_port: int = 8080
    # Host names the portal answers to besides localhost, 127.0.0.1 and
    # [::1] (and MCW_PORTAL_HOST when it is a specific address):
    # comma-separated, e.g. "mesh-wx.local,10.0.0.51". Anything else gets 400,
    # which is what stops a DNS-rebinding page from reaching the portal.
    portal_allowed_hosts: str = ""

    # Debug bridge: a development client (the iOS app in the simulator, over
    # an SSH tunnel) reads the datagrams this bot transmits and posts `>`
    # requests through the same path a DM takes. Off unless the portal is on
    # AND a token is set here; every call must carry the token. Not a feature
    # for users: it is how the app is developed without a radio.
    bridge_token: str = ""

    # Admin: pubkey prefix of admin user (can run admin DM commands). At least
    # 8 hex characters, ideally the 12 a DM carries; a shorter or non-hex
    # value is logged as an error and treated as unset.
    admin_key: str = ""

    # Where the radio may transmit: a key of REGION_BANDS. Frequencies outside
    # the region's band are refused, and the portal offers only its presets.
    radio_region: str = "US"

    # Radio transmit master switch. False = receive-only passive observer:
    # every outbound RF path (adverts, channel messages, binary datagrams,
    # DMs) becomes a logged no-op. Receiving, MQTT publishing and the web
    # portal are unaffected.
    tx_enabled: bool = True

    # MQTT: optional fire-and-forget publishing of received RF packets to a
    # broker for downstream consumers (e.g. CoreScope). Disabled by default;
    # turn on only after verifying the bot still works with mqtt_enabled=False.
    mqtt_enabled: bool = False
    mqtt_host: str = "mosquitto"  # Docker service name of the broker
    mqtt_port: int = 1883
    mqtt_topic_prefix: str = "meshcore"
    # Region code in the topic. Empty = the IATA code in the node's WX-<IATA>
    # name; with neither, MQTT publishing stays off (logged).
    mqtt_iata: str = ""
    mqtt_username: str = ""
    mqtt_password: str = ""
    # "origin" field in each published JSON envelope — this is the
    # observer name CoreScope and other consumers display.
    mqtt_origin: str = "meshcore-weather"

    # Weather history export (docs/METRICS_EXPORT.md). Both outputs are off
    # by default. metrics_influx_url is a full InfluxDB write URL, e.g.
    # http://influx.lan:8086/api/v2/write?org=home&bucket=weather (v2) or
    # http://influx.lan:8086/write?db=weather (v1); the token goes in the
    # Authorization header. The Prometheus page binds localhost only unless
    # metrics_prometheus_host is changed on purpose.
    metrics_influx_url: str = ""
    metrics_influx_token: str = ""
    metrics_interval_s: int = 60
    metrics_prometheus_enabled: bool = False
    metrics_prometheus_host: str = "127.0.0.1"
    metrics_prometheus_port: int = 9137
    # Comma-separated ICAO ids to export (e.g. "KAUS,KSAT"). Empty = every
    # station in the feed with a fresh observation, up to metrics_max_stations.
    metrics_stations: str = ""
    metrics_max_age_min: int = 180
    metrics_max_stations: int = 300

    # Local time zone for human-readable replies (IANA name). Wire messages
    # always carry UTC; only the text renderer uses this. Empty = the zone of
    # the home city's state, filled in at start (fill_timezone below).
    timezone: str = ""

    # Logging
    log_level: str = "INFO"

    # What the checks below refused while the settings were read, for the
    # start-up log and --check (nothing is logged this early).
    _rejected: list[str] = PrivateAttr(default_factory=list)

    @model_validator(mode="after")
    def _refuse_weak_admin_key(self) -> "Settings":
        problem = admin_key_problem(self.admin_key)
        if problem:
            self._rejected.append(f"MCW_ADMIN_KEY ignored: {problem}; admin commands are off")
            self.admin_key = ""
        return self

    @property
    def rejected(self) -> list[str]:
        """Settings refused when they were read (an admin key too short)."""
        return list(self._rejected)

    @property
    def dashboard_link(self) -> str:
        """The dashboard address to show a person: the public one when set."""
        return self.sdr_dashboard_public_url or self.sdr_dashboard_url

    # Appended by the internet-feed work (emwin/fetcher.py user_agent): how
    # NOAA's server administrators can reach this bot's operator, an email
    # address or URL, added to the User-Agent of every bundle fetch
    # ("meshcore-weather/0.1.0 (+https://github.com/digitaino/meshwx; you@example.org)").
    # Empty = the project's address only.
    operator_contact: str = ""


settings = Settings()
