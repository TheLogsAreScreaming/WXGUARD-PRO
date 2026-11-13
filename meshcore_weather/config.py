"""Application configuration via environment variables and .env file."""

from pathlib import Path

from pydantic_settings import BaseSettings


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

    # EMWIN data source
    emwin_source: str = "internet"  # "internet" or "sdr"
    emwin_poll_interval: int = 120  # seconds between data refreshes
    # "sdr": goesproc's emwin output tree (YYYY-MM-DD/ dirs of .TXT files)
    sdr_emwin_dir: str = "~/goes-images/emwin"
    sdr_poll_interval: int = 30     # seconds between directory scans
    # The dish's internet backup. With the source "sdr", once goesproc has
    # written nothing for this many minutes (a dish down for maintenance, a
    # lost lock) the bot also takes NOAA's internet bundle: emwin_base_url
    # once to cover the gap, then emwin_poll_url every emwin_poll_interval,
    # until the dish writes again. The same product has the same file name
    # either way, so nothing is held twice, and each product keeps the
    # source it came by. 0 = never.
    sdr_internet_fallback_min: int = 10
    # Radar pictures (spec 7D): a directory of EMWIN `*-RAD*.GIF` under YYYY-MM-DD/.
    # Empty means the dish's own EMWIN directory when the source is "sdr", and
    # no radar at all otherwise: the internet bundle carries no images.
    radar_dir: str = ""
    # goestools dashboard (signal stats, pointing mode) proxied into the admin portal
    sdr_dashboard_url: str = "http://127.0.0.1:8080"
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
    # Comma-separated lists, all optional, all additive (union). Empty = broadcast everything.
    home_cities: str = ""  # e.g. "Austin TX,San Antonio TX,Dallas TX"
    # Coverage radius (km) around the FIRST home city. The bot covers every
    # public forecast zone whose polygon lies within this circle, plus any
    # extra cities/states/WFOs listed. 0 disables the radius.
    home_radius_km: int = 120
    home_states: str = ""  # e.g. "TX,OK"
    home_wfos: str = ""    # e.g. "EWX,FWD,HGX"

    # Local web portal
    portal_enabled: bool = False
    portal_host: str = "0.0.0.0"
    portal_port: int = 8080

    # Debug bridge: a development client (the iOS app in the simulator, over
    # an SSH tunnel) reads the datagrams this bot transmits and posts `>`
    # requests through the same path a DM takes. Off unless the portal is on
    # AND a token is set here; every call must carry the token. Not a feature
    # for users: it is how the app is developed without a radio.
    bridge_token: str = ""

    # Admin: pubkey prefix of admin user (can run admin DM commands)
    admin_key: str = ""

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
    mqtt_iata: str = "AUS"
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
    # always carry UTC; only the text renderer uses this.
    timezone: str = "America/Chicago"

    # Logging
    log_level: str = "INFO"


settings = Settings()
