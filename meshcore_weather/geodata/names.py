"""Place names as people read them: the label rule of spec section 16.2.

Census and NWS tables name places in capitals with legal-form suffixes
("ADJUNTAS ZONA URBANA", "HELL'S KITCHEN"). Python's str.title() turns those
into "Hell'S Kitchen", "Central 14Th Street" and "Mcguire Afb". The rule here
is the one apps implement from the spec, so a place, a ZIP or a town reads the
same in a text reply and in the app: "Hell's Kitchen, NY 10019".
"""

import unicodedata

# Census legal and statistical descriptors nobody says, removed from the end of
# a name in this order, each at most once.
PLACE_SUFFIXES = (
    " CITY (BALANCE)", " (BALANCE)", " (HISTORICAL)", " (VILLAGE)",
    " CONSOLIDATED GOVERNMENT", " METROPOLITAN GOVERNMENT", " METRO GOVERNMENT",
    " UNIFIED GOVERNMENT", " URBAN COUNTY", " METRO TOWNSHIP",
    " ZONA URBANA", " COMUNIDAD", " COLONIA", " MUNICIPIO", " CDP", " CITY AND", " URBAN",
)

# Words kept in capitals. State codes are not: in place names LA, DE, IN, HI
# and OR are words ("La Grange", "De Queen", "Valley Hi"); DC is the one real code.
INITIALISMS = frozenset(
    "AFB AAF ARB ANGB NAS NAF NOLF MCAS USCG MCBH WMATA DC NE NW SE SW VA UC KC II III".split()
)

# Joining words, lower case anywhere but first ("Lake of the Woods", "Marina del Rey").
PARTICLES = frozenset("OF THE IN ON AT BY AND OR DE DEL DU".split())

# Apostrophes and the Hawaiian ʻokina with its stand-ins: inside a word, not between words.
MARKS = frozenset("'’‘ʻ`")


def _upper(text: str) -> str:
    return "".join(ch.upper() for ch in text)


def _lower(text: str) -> str:
    return "".join(ch.lower() for ch in text)


def _is_letter(ch: str) -> bool:
    return ch not in MARKS and unicodedata.category(ch)[0] == "L"


def _is_word_char(ch: str) -> bool:
    return ch in MARKS or _is_letter(ch) or unicodedata.category(ch) == "Nd"


def _case_word(word: str, first: bool) -> str:
    if word in INITIALISMS:
        return word
    if not first and word in PARTICLES:
        return _lower(word)
    out = []
    for i, ch in enumerate(word):
        if not _is_letter(ch):
            out.append(ch)
            continue
        capital = (
            i == 0
            or (i == 2 and word.startswith("MC"))                        # McAllen
            or (word[i - 1] in MARKS and (i == 1 or (i == 2 and _is_letter(word[0]))))  # ʻEwa, O'Fallon
        )
        out.append(ch if capital else _lower(ch))
    return "".join(out)


def title_case(text: str) -> str:
    """'HELL'S KITCHEN' -> "Hell's Kitchen", 'CENTRAL 14TH STREET' -> 'Central 14th
    Street', 'MCGUIRE AFB' -> 'McGuire AFB', 'LAKE OF THE WOODS' -> 'Lake of the Woods'.
    Any casing in, the same out."""
    s = _upper(text)
    out: list[str] = []
    i, first = 0, True
    while i < len(s):
        if not _is_word_char(s[i]):
            out.append(s[i])
            i += 1
            continue
        j = i
        while j < len(s) and _is_word_char(s[j]):
            j += 1
        out.append(_case_word(s[i:j], first))
        first = False
        i = j
    return "".join(out)


def place_name(name: str) -> str:
    """A place or town name as shown: 'ADJUNTAS ZONA URBANA' -> 'Adjuntas'."""
    n = _upper(name)
    for suffix in PLACE_SUFFIXES:
        if n.endswith(suffix):
            n = n[: -len(suffix)].rstrip(" ,")
    return title_case(n)


def place_label(name: str, state: str, zip5: str | None = None) -> str:
    """'Austin, TX' for a places.json entry, 'Austin, TX 78701' for a ZIP."""
    label = f"{place_name(name)}, {state}"
    return f"{label} {zip5}" if zip5 else label
