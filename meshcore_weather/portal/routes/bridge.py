"""The debug bridge: the iOS app as a client of this bot, with no radio.

Three things a development client needs and a radio would otherwise give
it: the datagrams this bot transmits (`/bridge/stream`, `/bridge/datagrams`),
a way to ask for one (`/bridge/request`, which runs the *same*
`AppResponder.handle_request` a DM does — same per-sender spacing, same
hourly budget, answer on the air), and who it is talking to
(`/bridge/info`).

Off unless the portal is enabled AND `MCW_BRIDGE_TOKEN` is set; every call
carries the token in `X-Bridge-Token` (or `Authorization: Bearer`). State
changes also need the portal's `X-Requested-With: meshcore-portal` header,
like every other POST. Bind the portal to 127.0.0.1 and reach it over an
SSH tunnel: nothing here is meant to face a network.
"""

from __future__ import annotations

import hmac
import logging
import re

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from meshcore_weather.bridge import RING, datagram_feed
from meshcore_weather.config import settings
from meshcore_weather.portal.sse import sse_response

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_REQUEST_CHARS = 200
MESHWX_DATA_TYPE = 0xFF10
_OUTCOME_SENT = re.compile(r"^(\d+) packet\(s\), (\d+) B$")


def _client_id(request: Request, fallback: str = "") -> str:
    """A short, safe name for the caller: its own if it gave one, else its
    address. Only ever used for the log line and the sender key."""
    raw = request.headers.get("x-bridge-client") or fallback or (
        request.client.host if request.client else "unknown")
    return re.sub(r"[^A-Za-z0-9_.:-]", "", str(raw))[:48] or "bridge"


def _authorise(request: Request) -> str:
    """Raise unless the bridge is on and the call carries its token.

    A bridge that is off is a 404: an old build and a build with the bridge
    disabled answer the same way. Returns the client id for the log.
    """
    if not settings.portal_enabled or not settings.bridge_token:
        raise HTTPException(404, "Not Found")
    header = request.headers.get("x-bridge-token") or ""
    if not header:
        auth = request.headers.get("authorization") or ""
        if auth[:7].lower() == "bearer ":
            header = auth[7:].strip()
    if not header or not hmac.compare_digest(header, settings.bridge_token):
        raise HTTPException(401, "bad or missing bridge token")
    return _client_id(request)


def _responder(request: Request):
    """The bot's AppResponder, or 503 when broadcasts are off."""
    broadcaster = getattr(request.app.state.bot, "_broadcaster", None)
    if broadcaster is None:
        raise HTTPException(503, "broadcasts are off: no data channel configured")
    return broadcaster


# -- The datagram feed --

@router.get("/bridge/datagrams")
async def bridge_datagrams(
    request: Request,
    since: int | None = Query(None, ge=0),
    limit: int = Query(RING, ge=1, le=RING),
) -> JSONResponse:
    """The ring buffer's catch-up as one JSON page, oldest first."""
    _authorise(request)
    items = datagram_feed.since(since, limit)
    return JSONResponse({
        "datagrams": [i.to_dict() for i in items],
        "cursor": items[-1].cursor if items else (since or datagram_feed.cursor),
        "latest": datagram_feed.cursor,
        "gap": datagram_feed.gap_after(since),
    })


@router.get("/bridge/stream")
async def bridge_stream(request: Request, since: int | None = Query(None, ge=0)):
    """SSE: the catch-up from the ring, then each datagram as it is transmitted.

    One JSON frame per datagram — `cursor`, `ts`, `data_type`, `hex`,
    `length`, `resend`, `attempt` — after the stream's `{"hello": true}`.
    Keep the last `cursor` you saw and pass it as `since` when you reconnect.
    """
    client = _authorise(request)
    logger.info("Bridge: %s opened the datagram feed (since=%s, cursor=%d)",
                client, since, datagram_feed.cursor)

    async def items():
        try:
            async for item in datagram_feed.subscribe(since):
                yield item.to_dict()
        finally:
            logger.info("Bridge: %s left the datagram feed", client)

    return sse_response(items())


# -- Requests --

@router.post("/bridge/request")
async def bridge_request(request: Request) -> JSONResponse:
    """Run one `>` request through the bot exactly as a DM would.

    Body: `{"text": ">o KAUS", "client": "sim"}`. The client id is the
    sender: the bridge client gets the same five-second spacing and shares
    the same hourly packet budget as anybody on the air. The answer goes out
    on the data channel as usual, so it arrives on the feed.

    Always 200 with an outcome — `sent`, `rate_limited`, `budget_spent` or
    `already_resent` — so a client can synthesise the radio's delivery
    confirmation on `sent` rather than read HTTP status codes.
    """
    client = _authorise(request)
    responder = _responder(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    text = str(body.get("text") or "").strip()
    client = _client_id(request, str(body.get("client") or ""))
    if not text.startswith(">"):
        raise HTTPException(400, "text must be a '>' request, e.g. '>o KAUS'")
    if len(text) > MAX_REQUEST_CHARS:
        raise HTTPException(400, f"text is longer than {MAX_REQUEST_CHARS} characters")

    sender_key = f"bridge:{client}"
    outcome = await responder.handle_request(text, sender_key)
    logger.info("Bridge: %s requested %r -> %s", client, text[:40], outcome)

    if outcome == "rate limited":
        return JSONResponse({"ok": False, "accepted": False, "outcome": "rate_limited",
                             "retry_after": float(settings.app_sender_gap_s), "detail": outcome})
    if outcome.startswith("hourly budget spent"):           # with or without the "busy" it was told
        return JSONResponse({"ok": False, "accepted": False, "outcome": "budget_spent",
                             "detail": outcome})
    # A `>part` whose every packet went out again in the last 30 s (spec 14.5).
    # Nothing was sent, so there is nothing for a client to confirm.
    if outcome == "already resent":
        return JSONResponse({"ok": False, "accepted": False, "outcome": "already_resent",
                             "retry_after": float(settings.part_resend_floor_s), "detail": outcome})
    m = _OUTCOME_SENT.match(outcome)
    return JSONResponse({
        "ok": True, "accepted": True, "outcome": "sent",
        "packets": int(m.group(1)) if m else 0,
        "bytes": int(m.group(2)) if m else 0,
        "cursor": datagram_feed.cursor,
        "detail": outcome,
    })


# -- Who am I talking to --

@router.get("/bridge/info")
async def bridge_info(request: Request) -> JSONResponse:
    """The bot's identity and channel, so a client can label what it sees."""
    _authorise(request)
    bot = request.app.state.bot
    info: dict = {}
    try:
        info = await bot.radio.info() or {}
    except Exception:
        logger.debug("Bridge: the radio could not be asked for its info", exc_info=True)
    bot_id = None
    broadcaster = getattr(bot, "_broadcaster", None)
    if broadcaster is not None:
        try:
            bot_id = broadcaster.scheduler.bot_id()
        except Exception:
            pass
    return JSONResponse({
        "ok": True,
        "name": info.get("name"),
        "public_key": info.get("public_key"),
        "bot_id": bot_id,
        "channel": settings.meshwx_channel,
        "data_type": MESHWX_DATA_TYPE,
        "tx_enabled": settings.tx_enabled,
        "cursor": datagram_feed.cursor,
        "ring": RING,
    })
