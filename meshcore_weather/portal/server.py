"""FastAPI app factory + uvicorn lifecycle for the operator web portal.

Runs alongside the bot as an asyncio task. This is the ADMIN portal
(radio, receiver, text-bot console, schedule, settings, logs); the goestools
dashboard on its own port is the public, read-only page. The portal itself
has no login: it binds 127.0.0.1 by default (reach it over an SSH tunnel),
and it answers only requests whose Host header is a name it was told about
(localhost, 127.0.0.1, [::1], MCW_PORTAL_ALLOWED_HOSTS), so a web page that
re-points its own DNS name at 127.0.0.1 (DNS rebinding) cannot drive it.
"""

import asyncio
import contextlib
import hashlib
import logging
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import PlainTextResponse

from meshcore_weather.config import portal_allowed_hosts, settings
from meshcore_weather.portal import logbuf

logger = logging.getLogger(__name__)

_PORTAL_DIR = Path(__file__).parent
_STATIC_DIR = _PORTAL_DIR / "static"
_TEMPLATES_DIR = _PORTAL_DIR / "templates"


def asset_version() -> str:
    """A short hash of the portal's script and stylesheet, for their URLs.

    They are served with a Last-Modified and no Cache-Control, so a browser
    is free to reuse its copy for hours without asking. After a deploy that
    meant the fresh page calling functions its stale script did not have: a
    new button that did nothing when pressed. A URL that changes with the
    contents is a copy no browser has."""
    digest = hashlib.sha256()
    for name in ("portal.js", "portal.css"):
        digest.update((_STATIC_DIR / name).read_bytes())
    return digest.hexdigest()[:12]


def host_of(header: str) -> str:
    """The host part of a Host header, lower case: 'localhost:8081' ->
    'localhost', '[::1]:8081' -> '[::1]'. Starlette's own check splits on the
    first colon and so never matches an IPv6 literal."""
    header = (header or "").strip().lower()
    if header.startswith("["):
        end = header.find("]")
        return header[:end + 1] if end > 0 else header
    if header.count(":") > 1:             # a bare IPv6 address, no port
        return header
    return header.split(":", 1)[0]


class HostCheck(TrustedHostMiddleware):
    """TrustedHostMiddleware with IPv6 literals understood: a request whose
    Host is not in the list gets 400 before any route sees it."""

    async def __call__(self, scope, receive, send) -> None:
        if self.allow_any or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        host = ""
        for name, value in scope.get("headers") or []:
            if name == b"host":
                host = host_of(value.decode("latin-1"))
                break
        for pattern in self.allowed_hosts:
            if host == pattern or (pattern.startswith("*.") and host.endswith(pattern[1:])):
                await self.app(scope, receive, send)
                return
        logger.warning("Portal: refused a request for Host %r (MCW_PORTAL_ALLOWED_HOSTS)", host[:80])
        await PlainTextResponse("Invalid host header", status_code=400)(scope, receive, send)


def create_app(bot: Any, allowed_hosts: list[str] | None = None) -> FastAPI:
    """Create a FastAPI app wired to a running bot instance.

    The bot exposes store, radio, emwin, and _broadcaster attributes
    that the routes read from (and occasionally trigger actions on).

    `allowed_hosts`: the Host header values to answer (PortalServer passes
    config.portal_allowed_hosts()). None leaves the Host unchecked, for an
    app built in-process by a test client; the server never builds one so.
    """
    app = FastAPI(
        title="Meshcore Weather Portal",
        docs_url=None,  # disable Swagger UI (depends on CDN assets)
        redoc_url=None,
    )

    templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))
    templates.env.globals["asset_version"] = asset_version()
    app.state.bot = bot
    app.state.templates = templates

    if allowed_hosts is not None:
        app.add_middleware(HostCheck, allowed_hosts=list(allowed_hosts), www_redirect=False)

    # Any state-changing request must carry a header that a cross-site page
    # cannot set without a CORS preflight (which we never answer). This is
    # what stops a web page someone on the LAN opens from flipping transmit
    # on or rewriting .env through their browser.
    @app.middleware("http")
    async def _require_xhr_header(request: Request, call_next):
        if request.method in ("POST", "PUT", "DELETE") and request.headers.get("x-requested-with") != "meshcore-portal":
            return Response('{"detail":"missing X-Requested-With: meshcore-portal"}', status_code=403,
                            media_type="application/json")
        return await call_next(request)

    # Mount static files (served from local disk, no CDN)
    app.mount(
        "/static",
        StaticFiles(directory=str(_STATIC_DIR)),
        name="static",
    )

    # Register routes
    from meshcore_weather.portal.routes import admin, api, bridge, pages
    app.include_router(pages.router)
    app.include_router(api.router, prefix="/api")
    app.include_router(admin.router, prefix="/api")
    # The debug bridge answers only when MCW_BRIDGE_TOKEN is set (bridge.py).
    app.include_router(bridge.router, prefix="/api")

    return app


class _Server(uvicorn.Server):
    """uvicorn with its hands off the process signals.

    `Server.serve()` calls `signal.signal` for SIGINT and SIGTERM, which
    replaces the handlers the bot installed before it (main.run). A systemd
    stop would then shut the web server down while the radio, the scheduler
    and the store ran on, and the bot's own shutdown would only start when
    uvicorn re-raised the signal on its way out. The bot owns the signals;
    the portal stops when stop() tells it to.
    """

    def install_signal_handlers(self) -> None:          # uvicorn < 0.29
        pass

    @contextlib.contextmanager
    def capture_signals(self):                          # uvicorn >= 0.29
        yield


class PortalServer:
    """Manages the uvicorn lifecycle as an asyncio task."""

    def __init__(self, bot: Any):
        self.bot = bot
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None

    def build_app(self) -> FastAPI:
        """The app the server runs: always with the Host check."""
        return create_app(self.bot, allowed_hosts=portal_allowed_hosts())

    async def start(self) -> None:
        logbuf.install()
        app = self.build_app()
        config = uvicorn.Config(
            app,
            host=settings.portal_host,
            port=settings.portal_port,
            log_level="warning",  # uvicorn logs are noisy, let the app log
            access_log=False,
            lifespan="off",
        )
        self._server = _Server(config)
        self._task = asyncio.create_task(self._server.serve())
        logger.info(
            "Portal running at http://%s:%d (answers Host: %s)",
            settings.portal_host,
            settings.portal_port,
            ", ".join(portal_allowed_hosts()),
        )
        # In a container 0.0.0.0 is the only way in; docker-compose publishes it on 127.0.0.1.
        if settings.portal_host.strip() in ("0.0.0.0", "::", "[::]") and not Path("/.dockerenv").exists():
            logger.warning("Portal listens on every interface and has no login: anyone who can reach port %d "
                           "can drive the radio. Prefer MCW_PORTAL_HOST=127.0.0.1 and an SSH tunnel (in Docker, "
                           "publish the port on 127.0.0.1); a LAN name or address must also be in "
                           "MCW_PORTAL_ALLOWED_HOSTS", settings.portal_port)

    async def stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
