"""Simple command parser. No LLM needed.

Supported formats:
    wx Austin TX
    wx KAUS
    wx 78701            (a ZIP or ZIP+4 is a place like any other)
    weather Austin TX   (the same as wx; "weather" alone is the help line)
    forecast Miami FL
    warn FL
    metar KJFK
    taf KJFK
    radar Austin TX     (what the newest radar picture shows there)
    sat
    status              (the operator's notices, and where the public page is)
    help
"""

import re
from collections.abc import Callable


# Command must be first word, followed by location
COMMAND_RE = re.compile(
    r"^(wx|weather|warn|warnings?|wanr|forecast|metar|taf|help|more|outlook|rain|radar|storm|storms|space|swx|solar)\b\s*(.*)",
    re.IGNORECASE,
)

# Receiver status takes no argument, so only the bare word counts:
# "satellite beach fl" and "signal mountain tn" stay places.
SAT_RE = re.compile(r"^(sat|satellite|goes|signal)[\s?!.]*$", re.IGNORECASE)

# The operator's notices (written on wx-admin, shown on the public page). The
# bare word only, as for sat.
STATUS_RE = re.compile(r"^(status|notices?)[\s?!.]*$", re.IGNORECASE)

# What the bot covers. No argument either, so the bare word only: "cove tx"
# and "coverage of round rock" stay places.
COV_RE = re.compile(r"^(cov|coverage|covers)[\s?!.]*$", re.IGNORECASE)

# Words people put after a command that are not places: "weather here",
# "forecast today", "wx now". The resolver would find Hereford, TX and Port
# Angeles, WA; the bot cannot know where "here" is, so it gives the help line.
_NOT_PLACES = {"here", "there", "now", "today", "tonight", "tomorrow", "please", "pls"}
_PLACE_WORDS = {"wx", "weather", "forecast", "warn", "warning", "warnings", "wanr", "outlook",
                "metar", "taf", "radar"}

# Normalize typos/aliases to canonical command names
_CMD_ALIASES = {"weather": "wx", "warnings": "warn", "warning": "warn", "wanr": "warn", "storms": "storm", "swx": "space", "solar": "space"}


async def parse_intent(text: str) -> dict:
    text = text.strip()
    if not text:
        return {"command": "help", "location": ""}

    if SAT_RE.match(text):
        return {"command": "sat", "location": ""}

    if COV_RE.match(text):
        return {"command": "cov", "location": ""}

    if STATUS_RE.match(text):
        return {"command": "status", "location": ""}

    m = COMMAND_RE.match(text)
    if m:
        cmd = m.group(1).lower()
        loc = m.group(2).strip()
        # "weather" alone is somebody who does not know the commands yet: the
        # help line, not the national summary a bare "wx" gives.
        if cmd == "weather" and not loc:
            return {"command": "help", "location": ""}
        if cmd in _PLACE_WORDS and loc.lower().strip(" ?!.") in _NOT_PLACES:
            return {"command": "help", "location": ""}
        cmd = _CMD_ALIASES.get(cmd, cmd)
        # Strip filler words
        for prefix in ["for ", "in ", "near ", "around "]:
            if loc.lower().startswith(prefix):
                loc = loc[len(prefix):]
        return {"command": cmd, "location": loc}

    # No recognized command - assume "wx" with the whole text as location
    return {"command": "wx", "location": text}


# -- People talking on the request channel ------------------------------------
#
# Every message on the channel used to be a request: one with no command word
# was looked up as a place, so people talking there were answered with
# "Unknown location: Meshwx make my thingy work", and a 🙌 with the national
# summary, two packets flooded across the mesh (#meshwx, 26 Sep - 1 Oct 2026:
# 7 of 33 messages). A DM is always addressed to the bot and is not judged here.

# "@[Name] " at the start: a message addressed to somebody, or to the bot.
_MENTION_RE = re.compile(r"^(?:@\[[^\]]*\]\s*)+")

# Command words people also use in sentences ("forecast looks bad", "weather
# here is wild", "more rain coming"): after one of these, only a place makes
# the message a request. wx, metar, taf and the rest are never prose.
_PROSE_WORDS = {"weather", "forecast", "warn", "warning", "warnings", "outlook", "radar",
                "rain", "storm", "storms", "more"}


def strip_mentions(text: str) -> str:
    """The message without the "@[Name]" mentions it starts with."""
    return _MENTION_RE.sub("", text).strip()


def place_shaped(text: str, states: set[str]) -> bool:
    """A ZIP code, or words ending in a state code ("Austin tx", "round rock,
    TX"): the form the help line gives, which conversation almost never has."""
    words = re.sub(r"[^\w\s]", " ", text).split()
    if len(words) == 1 and re.fullmatch(r"\d{5}", words[0]):
        return True
    if len(words) == 2 and re.fullmatch(r"\d{5}", words[0]) and re.fullmatch(r"\d{4}", words[1]):
        return True                                  # 78701-1234
    return len(words) >= 2 and words[-1].upper() in states


def _clean(text: str) -> str:
    """What the place lookup is given: the characters a place name has."""
    return re.sub(r"[^\w\s,.'-]", "", text).strip(" .")


def _names_the_place(query: str, loc: dict | None) -> bool:
    """The lookup matches loosely ("oh hi" finds Kaneohe, HI and "ok ok"
    Oklahoma City), so a message with no command word is a place only when
    the place found is the one typed: three letters or more, and the name
    found starts with them. A ZIP is the ZIP table or nothing."""
    if not loc:
        return False
    words = re.sub(r"[^\w\s]", " ", query).split()
    if words and re.fullmatch(r"\d{5}", words[0]):
        return True
    city = " ".join(words[:-1]).lower()
    return len(city) >= 3 and (loc.get("name") or "").lower().startswith(city)


def is_conversation(text: str, *, resolve: Callable[[str], dict | None], states: set[str]) -> bool:
    """True when a message on the request channel is people talking rather
    than a request, so the bot stays quiet.

    - Nothing but emoji, punctuation or a mention: talking.
    - No command word: a request only when it is place-shaped and names a
      place ("Austin tx", "78644"). A bare word is not enough: nice, cool,
      hope, why and joy are towns, and lol, ack and hey are airports.
    - A command word people use in sentences: a request when what follows is
      a place, is place-shaped, or is one word (a misspelt town still gets
      "Unknown location"). "more" counts alone or with one word ("more
      storm").
    - Any other command word (wx, metar, help, ...): always a request.
    """
    t = strip_mentions(text)
    if not any(c.isalnum() for c in t):
        return True
    if SAT_RE.match(t) or COV_RE.match(t) or STATUS_RE.match(t):
        return False
    m = COMMAND_RE.match(t)
    if not m:
        return not (place_shaped(t, states) and _names_the_place(t, resolve(_clean(t))))
    word, rest = m.group(1).lower(), m.group(2).strip()
    if word not in _PROSE_WORDS or not rest:
        return False
    if len(rest.split()) == 1:
        return False                                 # "storm TX", "more storm", "forecast lockhrt"
    if word == "more":
        return True                                  # "more rain coming"
    return not (place_shaped(rest, states) or resolve(_clean(rest)) is not None)
