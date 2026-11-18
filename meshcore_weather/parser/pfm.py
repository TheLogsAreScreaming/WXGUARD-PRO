"""Parse NWS Point Forecast Matrix (PFM) products into structured forecasts.

PFM is a fixed-column text format issued by NWS WFOs for specific forecast
points (airports, cities). Each PFM product contains multiple forecast
points. Each point has:

  - A 3-hourly table for days 1-3 (Temp, Dewpt, RH, Wind, Clouds, PoP, etc.)
  - A 6-hourly table for days 4-7 (Max/Min, Temp, Wind char, etc.)

pyIEM does not have a PFM parser, so we write our own. The parser is
intentionally lightweight — it extracts only the fields we need to
populate the 0x31 Forecast wire format (high/low temp, sky code, PoP,
wind, condition flags). It does NOT aim to reproduce the full PFM data
model.

Column parsing strategy:
  - Find the "<TZ> 3hrly" header row for table 1 (or "6hrly" for table 2).
  - Record the character position of each time-column in that row.
  - For every data row below, extract the value occupying each column.
  - An empty column (spaces only) means "no data for that time slot".

Row parsing is tolerant of label variations ("Rain shwrs" vs "Rain") and
of optional rows (Wind gust, Heat index, Drizzle, etc.).

The UTC row is always present after the local-time row and is what we
use to compute absolute timestamps, so we never have to deal with local
timezones or DST.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone

logger = logging.getLogger(__name__)


# -- Label / row detection -----------------------------------------------------

# The label portion of a PFM row occupies ~the first 14 chars. Everything
# after that is column-aligned data. Some WFO rows vary in label length so
# we match a prefix loosely.
_LABEL_END = 14

# Rows we care about. Keys are canonical labels; values are regexes that
# match the *start* of the label (case-insensitive, anchored to column 0).
# A label ends where no lower-case letter follows, not at a word boundary:
# NWS sometimes drops the spaces between a label and its first value
# ("Temp52 49 43 ...", BOX 2026-10-17; "Max/Min70", EWX; "Avg cloudsFW",
# LUB), and such a row is still that row (see _unglue_row).
_END = r"(?-i:(?![a-z]))"
_ROW_PATTERNS = {
    "temp": re.compile(r"^\s*Temp" + _END, re.IGNORECASE),
    "dewpt": re.compile(r"^\s*Dewpt" + _END, re.IGNORECASE),
    "rh": re.compile(r"^\s*RH" + _END, re.IGNORECASE),
    "wind_dir": re.compile(r"^\s*Wind\s*dir" + _END, re.IGNORECASE),
    "wind_spd": re.compile(r"^\s*Wind\s*spd" + _END, re.IGNORECASE),
    "wind_gust": re.compile(r"^\s*Wind\s*gust" + _END, re.IGNORECASE),
    "wind_char": re.compile(r"^\s*Wind\s*char" + _END, re.IGNORECASE),  # 6hrly table
    "pwind_dir": re.compile(r"^\s*PWind\s*dir" + _END, re.IGNORECASE),  # 6hrly table
    "clouds": re.compile(r"^\s*(Avg\s+)?Clouds" + _END, re.IGNORECASE),
    "pop12": re.compile(r"^\s*PoP\s*12hr" + _END, re.IGNORECASE),
    "qpf12": re.compile(r"^\s*QPF\s*12hr" + _END, re.IGNORECASE),
    "snow12": re.compile(r"^\s*Snow\s*12hr" + _END, re.IGNORECASE),
    "rain": re.compile(r"^\s*Rain(\s+shwrs?)?" + _END, re.IGNORECASE),
    "tstm": re.compile(r"^\s*Tstms?" + _END, re.IGNORECASE),
    "obvis": re.compile(r"^\s*Obvis" + _END, re.IGNORECASE),
    "min_max": re.compile(r"^\s*(Min/Max|Max/Min)" + _END, re.IGNORECASE),
    "max_min": re.compile(r"^\s*(Min/Max|Max/Min)" + _END, re.IGNORECASE),  # 6hrly same row
}
# Rows whose values sit only at 00Z and 12Z columns (12-hourly periods).
_TWELVE_HOURLY = {"pop12", "qpf12", "min_max", "max_min"}

# Detect the hour header rows (local TZ and UTC)
# Local header: "CDT 3hrly", but Alaska/Guam/Hawaii write "AKDT3hrly" and
# "ChST3hrly" (4-letter zone, no space), so the gap is optional. So is the
# gap after "hrly": "MDT 6hrly00   06 12 18" (TFX and CYS, whose 6-hourly
# tables were dropped and their rows read into the 3-hourly table, giving
# Lewistown MT a low of 3), "UTC 3hrly21 00 03", "UTC 6hrly06 12 18".
_HRLY_LOCAL_RE = re.compile(
    r"^(?P<label>\s*[A-Za-z]{3,4}\s*(?P<interval>3hrly|6hrly))\s*(?P<hours>\d.*)$",   # ChST (Guam) is mixed case
    re.IGNORECASE,
)
_HRLY_UTC_RE = re.compile(
    r"^\s*UTC\s*(?P<interval>3hrly|6hrly)\s*(?P<hours>\d.*)$",
    re.IGNORECASE,
)
# Any hour header, parsed or not: where one table's rows stop.
_ANY_HRLY_RE = re.compile(r"^\s*[A-Za-z]{3,4}\s*[36]hrly", re.IGNORECASE)

# Point header: UGC line, then a non-blank name, then a coord line.
_UGC_RE = re.compile(r"^([A-Z]{2}[ZC]\d{3})(?:[->]\d{3})*-\d{6}-\s*$")
# "30.19N  97.67W Elev. 462 ft"; Guam is "13.48N 144.79E", Samoa is south.
_COORD_RE = re.compile(
    r"^\s*(?P<lat>\d+(?:\.\d+)?)(?P<ns>[NS])\s+(?P<lon>\d+(?:\.\d+)?)(?P<ew>[EW])"
    r"(?:\s+Elev\.?\s+(?P<elev>\d+)\s*ft)?"
)
# Product issue time: e.g. "1245 PM CDT Fri Apr 10 2026"
_ISSUE_RE = re.compile(
    r"^\s*(\d{1,4})\s*(AM|PM)\s+([A-Z]{3})\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})",
    re.IGNORECASE,
)
# Product AFOS line (e.g. "PFMEWX")
_AFOS_RE = re.compile(r"^\s*PFM([A-Z]{3})\s*$")


# -- Dataclasses --------------------------------------------------------------


@dataclass
class PFMSlot:
    """One time-column slot in a PFM table."""
    dt: datetime                      # UTC datetime at the start of this slot
    interval_hours: int               # 3 or 6
    temp_f: int | None = None
    dewpt_f: int | None = None
    rh_pct: int | None = None
    wind_dir: str = ""                # compass string (e.g. "SE")
    wind_spd_mph: int | None = None
    wind_gust_mph: int | None = None
    cloud: str = ""                   # CL / FW / SC / B1 / B2 / OV
    pop_pct: int | None = None        # 12hr PoP (sparse — only at 12hr boundaries)
    qpf_in: float | None = None       # 12hr QPF
    rain: str = ""                    # C / L / S / D likelihood
    tstm: str = ""
    obvis: str = ""                   # obstruction code (PF / F / BS / ...)
    minmax_f: int | None = None       # Min/Max (Max/Min) row value at this column:
                                      # the daytime max sits at the evening column,
                                      # the overnight min at the morning column


@dataclass
class PFMPoint:
    """One forecast point parsed from a PFM product."""
    name: str
    lat: float
    lon: float
    elev_ft: int | None = None
    zone: str = ""                    # UGC code
    issue_time: datetime | None = None  # UTC
    wfo: str = ""                     # 3-letter WFO code
    tz_offset_hours: int = 0          # LOCAL - UTC (e.g. -5 for CDT). Used
                                      # by the downsampler to group slots by
                                      # LOCAL calendar day.
    slots: list[PFMSlot] = field(default_factory=list)

    def local_date(self, dt: datetime) -> date:
        """Return the calendar date of `dt` in the point's local timezone."""
        return (dt + timedelta(hours=self.tz_offset_hours)).date()

    def local_hour(self, dt: datetime) -> int:
        """Return the local hour (0-23) of `dt`."""
        return (dt + timedelta(hours=self.tz_offset_hours)).hour


# -- Column position helpers --------------------------------------------------


def _find_column_positions(hrly_line: str, label_end: int) -> list[int]:
    """Return the start column of each time slot in a "<tz> 3hrly" header row.

    Data rows below this header place their values at the same columns.
    Each value is right-aligned in a 3-char-wide slot (2 chars value + space).
    We scan the hours field and record every non-space run.
    """
    positions: list[int] = []
    i = label_end
    while i < len(hrly_line):
        if hrly_line[i] != " ":
            # Start of a value; record and skip to next space
            positions.append(i)
            while i < len(hrly_line) and hrly_line[i] != " ":
                i += 1
        else:
            i += 1
    return positions


def _extract_slot_value(row: str, start_col: int, width: int = 3) -> str:
    """Extract the value at a column position from a data row.

    The column is `width` chars wide, centered on start_col. Real PFM uses
    right-aligned 3-char slots, so we extract chars [start_col - 1 .. start_col + 1]
    and strip whitespace.
    """
    # Right-align: value is typically 2 chars ending at start_col + 1
    # But cloud codes, wind dirs etc. can be in different positions.
    # Use a 3-char window starting at start_col - 1.
    lo = max(0, start_col - 1)
    hi = min(len(row), start_col + 2)
    return row[lo:hi].strip()


def _parse_int(s: str) -> int | None:
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def _parse_float(s: str) -> float | None:
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


# -- Timestamp construction ---------------------------------------------------


_MONTH = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def _parse_issue_time(line: str) -> datetime | None:
    """Parse the PFM issue time line, e.g. '1245 PM CDT Fri Apr 10 2026'.

    Returns a UTC datetime. We actually don't care about the local time
    for table parsing (we use the UTC row directly) — this is only used as
    a stable "issued at" reference for the 0x31 issued_hours_ago field.
    """
    m = _ISSUE_RE.match(line)
    if not m:
        return None
    hhmm, ampm, tz, mon_str, day_s, year_s = m.groups()
    try:
        year = int(year_s)
        mon = _MONTH.get(mon_str.upper())
        if not mon:
            return None
        day = int(day_s)
        if len(hhmm) <= 2:
            hh, mm = int(hhmm), 0
        else:
            hh, mm = int(hhmm[:-2]), int(hhmm[-2:])
        if ampm.upper() == "PM" and hh < 12:
            hh += 12
        elif ampm.upper() == "AM" and hh == 12:
            hh = 0
        # Convert local → UTC using a simple offset table. Good enough for
        # a reference timestamp; we don't depend on this for table parsing.
        offset = _TZ_OFFSET.get(tz.upper(), 0)
        local_naive = datetime(year, mon, day, hh, mm)
        return (local_naive + timedelta(hours=-offset)).replace(tzinfo=timezone.utc)
    except (ValueError, KeyError):
        return None


# US timezone offsets (hours ahead of UTC). Negative = west of UTC.
# Sign convention here: local_utc = local + (-offset) so positive means
# LOCAL is ahead of UTC. For CDT (UTC-5), offset = -5.
# Every abbreviation an NWS product header (MND line) carries: the storm
# report and warning code read the same table (core/services, protocol/warnings).
TZ_ABBR_OFFSET = {
    "EST": -5, "EDT": -4,
    "CST": -6, "CDT": -5,
    "MST": -7, "MDT": -6,
    "PST": -8, "PDT": -7,
    "AKST": -9, "AKDT": -8,
    "HST": -10,  # Hawaii, and the Aleutians in winter
    "HDT": -9,   # the Aleutians in summer (America/Adak)
    "AST": -4,   # Atlantic (Puerto Rico, Virgin Islands; no DST)
    "ChST": 10,  # Chamorro (Guam, Northern Marianas)
    "CHST": 10,
    "SST": -11,  # Samoa
}
_TZ_OFFSET = TZ_ABBR_OFFSET


def _build_slot_times(
    utc_hours: list[int], issue_time: datetime, interval: int
, start_date: date | None = None, first_local_hour: int | None = None) -> list[datetime]:
    """Build a list of UTC datetimes for each time slot.

    The UTC hours come out of the PFM header row (e.g. "21 00 03 06 ...").
    We start at the issue date and walk forward, advancing the date whenever
    the hour wraps (next hour < previous hour).
    """
    if not utc_hours:
        return []
    # (start_date / first_local_hour: see the Date-row anchoring below.)
    # The first slot is the smallest UTC hour >= issue_time's hour, on the
    # issue_time's date (or the next day if it wraps). Actually simpler: the
    # first slot IS the first non-missing value's timestamp, which by
    # convention is the first hour in the header that equals or follows
    # issue_time rounded up to the next interval boundary.
    #
    # For our purposes the exact anchor isn't critical — we need CONSISTENT
    # datetimes across the series, and we use "day offset from issue date"
    # to group them. So:
    #   - start date = issue_time.date() in UTC
    #   - first hour < issue_time.hour means we've already rolled into tomorrow
    if start_date is not None:
        # Anchor from the table's own "Date" row (local calendar date of the
        # first column). If the first column's UTC hour is smaller than its
        # local hour, that column has already rolled into the next UTC day.
        start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        if first_local_hour is not None and utc_hours[0] < first_local_hour:
            start = start + timedelta(days=1)
    else:
        # Legacy fallback: assume the table starts on the issue date. Only
        # correct for the first (3-hourly) table.
        start = datetime(
            issue_time.year, issue_time.month, issue_time.day,
            tzinfo=timezone.utc,
        )
        if utc_hours[0] < issue_time.hour:
            start = start + timedelta(days=1)

    times: list[datetime] = []
    prev_hour = -1
    cur = start
    for h in utc_hours:
        if h <= prev_hour:
            # Wrapped past midnight — advance a day
            cur = cur + timedelta(days=1)
        cur = cur.replace(hour=h)
        times.append(cur)
        prev_hour = h
    return times


# -- Main parser --------------------------------------------------------------


_GLUED_HRLY_RE = re.compile(r"(?<=\S)\s*(?=[A-Za-z]{3,4}\s+[36]hrly\s)")


def _split_glued_headers(lines: list[str]) -> list[str]:
    """Repair a PFM row where NWS dropped the newline between a "Date" row
    and the following "<TZ> 6hrly" header (seen in KEWX 2026-09-13: the
    New Braunfels point's second table was "...Sun 09/20/26CDT 6hrly 13 19").
    Without this the 6-hourly table is never recognised for that point."""
    out: list[str] = []
    for line in lines:
        # "...Heat  Y  Y  YDate          Thu 09/17/26  Fri ..." (HGX over the
        # satellite, 2026-09-14): the 6-hourly Date row glued to the row
        # before it. Without the row the second table is dated two days early.
        m = _GLUED_DATE_RE.search(line)
        if m and line[:m.start()].strip():
            out.append(line[:m.start()].rstrip())
            line = line[m.start():]
        else:
            # Generic: a row label glued after data ("...  Y  YTstms   S").
            # The row before the label may be an hour header rather than a
            # data row: "UTC 6hrly  06 12 18 00 ... 18 00Min/Max  34  67"
            # (JKL 2026-10-17, and 2.6% of PFMs over three days) read as a
            # UTC hour of 34 and lost the point.
            for gm in _GLUED_ROW_RE.finditer(line):
                if gm.start() >= 14 and line[:gm.start()].strip() and (
                        _classify_row(line) is not None
                        or _HRLY_UTC_RE.match(line) or _HRLY_LOCAL_RE.match(line)):
                    out.append(line[:gm.start()].rstrip())
                    line = line[gm.end():] if gm.end() > gm.start() else line[gm.start():]
                    break
        if "hrly" in line and not _HRLY_LOCAL_RE.match(line):
            parts = _GLUED_HRLY_RE.split(line, maxsplit=1)
            if len(parts) == 2 and _HRLY_LOCAL_RE.match(parts[1]):
                out.append(parts[0])
                out.append(parts[1])
                continue
        out.append(line)
    return out


_GLUED_DATE_RE = re.compile(r"(Date\s{2,}(?:[A-Z][a-z]{2}\s+)?\d{2}/\d{2}(?:/\d{2})?)")

# Every row label a PFM table can carry. A label found mid-line, after
# column 14, preceded by a data token, means NWS (or the link) dropped a
# newline: split there. Structure over luck.
_ROW_LABELS = ("Date", "Min/Max", "Max/Min", "Temp", "Dewpt", "RH", "Wind dir", "Wind spd", "Wind gust",
               "Clouds", "PoP 12hr", "QPF 12hr", "Snow 12hr", "Rain shwrs", "Rain", "Tstms", "Snow", "Sleet",
               "FrzgRain", "Obvis", "Heat", "Max heat", "Wind chill", "Min chill", "PWind dir", "Wind char",
               "Avg clouds", "UTC 3hrly", "UTC 6hrly")
_GLUED_ROW_RE = re.compile(
    r"(?<=[\w%/])\s*(?=(?:" + "|".join(re.escape(l) for l in _ROW_LABELS) + r"|[A-Z][A-Za-z]{2,3} [36]hrly)\s{2,})")


def parse_pfm(text: str) -> list[PFMPoint]:
    """Parse a full PFM product into a list of forecast points.

    Tolerant of missing rows, label variations, and empty columns.
    Returns one PFMPoint per forecast point in the product.
    """
    lines = _split_glued_headers(text.splitlines())

    # Find the product-level WFO (from the AFOS line) and issue time
    wfo = ""
    product_issue: datetime | None = None
    for i, line in enumerate(lines[:20]):
        m = _AFOS_RE.match(line)
        if m:
            wfo = m.group(1)
        if product_issue is None:
            t = _parse_issue_time(line)
            if t is not None:
                product_issue = t

    # Scan for forecast points
    points: list[PFMPoint] = []
    i = 0
    while i < len(lines):
        # Look for a UGC line
        m_ugc = _UGC_RE.match(lines[i])
        if not m_ugc:
            i += 1
            continue
        zone = m_ugc.group(1)

        # Next non-blank line is the point name
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines):
            break
        name = lines[j].strip()

        # Next non-blank line is the coord/elev line
        k = j + 1
        while k < len(lines) and not lines[k].strip():
            k += 1
        if k >= len(lines):
            break
        m_coord = _COORD_RE.match(lines[k])
        if not m_coord:
            # Not a forecast point — maybe a UGC line that isn't followed by
            # a name/coord pair. Skip past it and keep looking.
            i = k
            continue
        lat = float(m_coord.group("lat")) * (-1 if m_coord.group("ns") == "S" else 1)
        lon = float(m_coord.group("lon")) * (-1 if m_coord.group("ew") == "W" else 1)
        elev = _parse_int(m_coord.group("elev")) if m_coord.group("elev") else None

        # Per-point issue time line (may be the same as the product issue time)
        point_issue = product_issue
        k2 = k + 1
        while k2 < len(lines) and not lines[k2].strip():
            k2 += 1
        if k2 < len(lines):
            t = _parse_issue_time(lines[k2])
            if t is not None:
                point_issue = t

        # Parse both tables (3hrly and 6hrly) until we hit another UGC line
        # or the end of the product.
        next_ugc = len(lines)
        for mm in range(k2 + 1, len(lines)):
            if _UGC_RE.match(lines[mm]):
                next_ugc = mm
                break
        table_lines = lines[k2:next_ugc]

        # Scan table_lines for the first <TZ> hrly header to extract the
        # point's local TZ offset. Used by the downsampler to group slots
        # by local calendar day rather than UTC.
        tz_offset = 0
        for line in table_lines:
            m_local = _HRLY_LOCAL_RE.match(line)
            if m_local and "UTC" not in line.upper():
                # Extract the timezone abbreviation from the label
                label = m_local.group("label").strip()
                m_tz = re.match(r"[A-Za-z]{3,4}", label)     # "ChST3hrly" has no space
                if m_tz:
                    tz_offset = _TZ_OFFSET.get(m_tz.group(0).upper(), 0)
                break

        # One malformed point must not take down the whole product (seen in
        # the wild: an NWS PFM with two header columns run together in one
        # point's table). Skip the point and keep parsing the rest.
        try:
            slots = _parse_point_tables(table_lines, point_issue or datetime.now(timezone.utc))
        except (ValueError, IndexError) as exc:
            logger.warning("PFM point %s (%s) skipped: %s", zone, name, exc)
            i = next_ugc
            continue

        points.append(
            PFMPoint(
                name=name,
                lat=lat,
                lon=lon,
                elev_ft=elev,
                zone=zone,
                issue_time=point_issue,
                wfo=wfo,
                tz_offset_hours=tz_offset,
                slots=slots,
            )
        )
        i = next_ugc

    return points


_DATE_TOKEN_RE = re.compile(r"(\d{2})/(\d{2})(?:/(\d{2}))?")


_DATE_LABEL_RE = re.compile(r"(?:[A-Za-z]{3}\s+)?(\d{2})/(\d{2})(?:/(\d{2}))?")


def _slot_times_from_local(
    hours: list[int], positions: list[int], date_row: str | None, tz_offset: int, issue_time: datetime,
) -> list[datetime] | None:
    """Exact slot timestamps from the LOCAL hour header and the Date row.

    `hours` are the local header's hours and `positions` their columns (the
    table's data columns when the counts agree: a header glued to its label,
    "MDT 6hrly00   06 12", sits left of them).

    Columns are grouped into local days wherever the local hour wraps
    (e.g. 22 -> 01). The Date row's labels are CENTRED over each day's
    columns and the first day may carry no label at all when the table
    starts with a leftover column from the previous day (Phoenix:
    "MST 6hrly 23 | 05 11 17 23 ..." under "Date      Wed 09/16/26"). So:
    find the day group a date label sits over, give it that date, and count
    days outward. Returns None when the rows can't be interpreted.
    """
    if date_row is None:
        return None
    if not hours or len(positions) != len(hours):
        return None
    # Day groups: list of (first_col_pos, last_col_pos, [col indexes])
    groups: list[list[int]] = [[0]]
    for k in range(1, len(hours)):
        if hours[k] <= hours[k - 1]:
            groups.append([k])
        else:
            groups[-1].append(k)
    labels = []
    for m in _DATE_LABEL_RE.finditer(date_row):
        month, day = int(m.group(1)), int(m.group(2))
        year = 2000 + int(m.group(3)) if m.group(3) else issue_time.year
        if not m.group(3) and month < issue_time.month - 6:
            year += 1
        try:
            labels.append((m.start(), m.end(), date(year, month, day)))
        except ValueError:
            continue
    if not labels:
        return None
    # Which group is the first label over? A label "sits over" a group when
    # its span overlaps the group's column span (with 2 chars of slack).
    anchor_group, anchor_date = None, None
    for start, end, d in labels:
        for gi, g in enumerate(groups):
            g_lo = positions[g[0]] - 2
            g_hi = positions[g[-1]] + 4
            if start < g_hi and end > g_lo:
                anchor_group, anchor_date = gi, d
                break
        if anchor_group is not None:
            break
    if anchor_group is None:
        anchor_group, anchor_date = 0, labels[0][2]
    times: list[datetime] = []
    for gi, g in enumerate(groups):
        d = anchor_date + timedelta(days=gi - anchor_group)
        for k in g:
            local_dt = datetime(d.year, d.month, d.day, hours[k], tzinfo=timezone.utc)
            times.append(local_dt - timedelta(hours=tz_offset))
    return times


def _table_start_date(lines: list[str], header_idx: int, issue_time: datetime) -> date | None:
    """Local calendar date of a PFM table's first column, from the "Date" row
    that sits (usually directly) above the "<TZ> Nhrly" header row.

    Returns None if no Date row is found within a few lines, in which case the
    caller falls back to the issue date.
    """
    for k in range(header_idx - 1, max(-1, header_idx - 4), -1):
        row = lines[k]
        if not row.lstrip().lower().startswith("date"):
            continue
        m = _DATE_TOKEN_RE.search(row)
        if not m:
            return None
        month, day = int(m.group(1)), int(m.group(2))
        if m.group(3):
            year = 2000 + int(m.group(3))
        else:
            year = issue_time.year
            if month < issue_time.month - 6:   # December product, January column
                year += 1
        try:
            return date(year, month, day)
        except ValueError:
            return None
    return None


def _parse_hour_tokens(hours_text: str) -> list[int]:
    """Turn a PFM hour header ("21 00 03 06 ...") into a list of UTC hours.

    NWS products occasionally run two columns together ("09 1215 18"). Hours
    are always two digits, so an even-length run of digits is split back into
    2-digit hours. Anything outside 0..23 raises ValueError so the caller can
    skip the point rather than build impossible timestamps.
    """
    hours: list[int] = []
    for tok in hours_text.split():
        if not tok.isdigit():
            continue
        if len(tok) > 2 and len(tok) % 2 == 0:
            parts = [tok[k:k + 2] for k in range(0, len(tok), 2)]
        else:
            parts = [tok]
        for p in parts:
            h = int(p)
            if not 0 <= h <= 23:
                raise ValueError(f"bad UTC hour {p!r} in PFM header: {hours_text.strip()[:40]}")
            hours.append(h)
    return hours


def _parse_point_tables(lines: list[str], issue_time: datetime) -> list[PFMSlot]:
    """Parse both the 3-hourly and 6-hourly tables for a single forecast point.

    Returns a combined time-sorted list of PFMSlot entries.
    """
    slots: list[PFMSlot] = []

    # Find all occurrences of "<TZ> 3hrly" or "<TZ> 6hrly" header rows
    # (could be 1 or 2 tables per point)
    i = 0
    while i < len(lines):
        m_local = _HRLY_LOCAL_RE.match(lines[i])
        if not m_local or "UTC" in m_local.group("label").upper():
            i += 1
            continue

        interval = 3 if "3" in m_local.group("interval") else 6

        # The next non-blank line should be the UTC header
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines):
            break
        m_utc = _HRLY_UTC_RE.match(lines[j])
        if not m_utc:
            i = j
            continue
        utc_hours = _parse_hour_tokens(m_utc.group("hours"))

        # The table's rows run to the next table: its Date row or any hour
        # header, read or not. Stopping only at a header that parsed let the
        # rows of a 6-hourly table whose header did not ("MDT 6hrly00") land
        # in the 3-hourly table's columns (Lewistown MT: a low of 3).
        end = next((k for k in range(j + 1, len(lines))
                    if (_ANY_HRLY_RE.match(lines[k]) and "UTC" not in lines[k].upper()[:6])
                    or lines[k].lstrip().lower().startswith("date")), len(lines))
        rows = lines[j + 1:end]
        positions = _table_columns(lines[i], m_local, lines[j], m_utc, len(utc_hours), rows)

        # Anchor the table on its own "Date" row (the line above the local
        # hrly header, e.g. "Date           09/16  Thu 09/17/26 ..."). Without
        # this the 6-hourly table was stamped with the issue date and days
        # 4-7 landed on top of days 1-4.
        # Preferred: exact times from the local header + Date row + zone
        # offset (handles centred labels and unlabeled leading columns).
        date_row = next(
            (lines[k] for k in range(i - 1, max(-1, i - 4), -1)
             if lines[k].lstrip().lower().startswith("date")),
            None,
        )
        tz_label = re.match(r"^\s*([A-Za-z]{3,4})", m_local.group("label"))
        tz_off = _TZ_OFFSET.get(tz_label.group(1).upper() if tz_label else "", None)
        if tz_off is None and tz_label:
            tz_off = _TZ_OFFSET.get(tz_label.group(1))
        times = None
        local_hours = _parse_hour_tokens(m_local.group("hours"))
        if tz_off is not None:
            local_cols = positions if len(positions) == len(local_hours) else \
                _find_column_positions(lines[i], m_local.start("hours"))
            times = _slot_times_from_local(local_hours, local_cols, date_row, tz_off, issue_time)
        if (times is None or len(times) != len(utc_hours)) and interval == 6 and slots and tz_off is not None:
            # The 6-hourly table always begins the local day after the
            # 3-hourly table ends; rebuild its times from that fact when the
            # Date row did not survive the link.
            last_local = (slots[-1].dt + timedelta(hours=tz_off)).date()
            start_local = last_local + timedelta(days=1)
            built, day, prev = [], start_local, -1
            for h in local_hours:
                if h <= prev:
                    day += timedelta(days=1)
                built.append((datetime(day.year, day.month, day.day, h) - timedelta(hours=tz_off)).replace(tzinfo=timezone.utc))
                prev = h
            if len(built) == len(utc_hours):
                times = built
        if times is None or len(times) != len(utc_hours):
            # Fallback: UTC header anchored on the first Date token.
            start_date = _table_start_date(lines, i, issue_time)
            local_tokens = [x for x in m_local.group("hours").split() if x.isdigit()]
            first_local_hour = int(local_tokens[0][:2]) if local_tokens else None
            times = _build_slot_times(
                utc_hours, issue_time, interval,
                start_date=start_date, first_local_hour=first_local_hour,
            )

        table_slots = [PFMSlot(dt=t, interval_hours=interval) for t in times]
        twelve_cols = _twelve_hourly_columns(rows, positions, utc_hours)
        for row in rows:
            found = _classify_row_span(row)
            if found is None:
                continue
            row_kind, label_end = found
            if label_end < len(row) and not row[label_end].isspace():
                # "Temp52 49 43 ...": the spaces between label and first value
                # were dropped. Put the values back on the columns.
                row = _unglue_row(row, label_end, positions,
                                  twelve_cols if row_kind in _TWELVE_HOURLY else None)
                if row is None:
                    continue   # cannot be placed: leave the row out rather than misread it
            _apply_row(row_kind, row, positions, table_slots)

        slots.extend(table_slots)

        # Advance to the next table's header so it gets parsed too. (Skipping
        # past it left every point with only its 3-hourly table, i.e. ~3 days
        # of forecast instead of 7.)
        i = end

    return slots


def _classify_row(row: str) -> str | None:
    """Return the canonical row kind ('temp', 'wind_dir', etc.) or None."""
    found = _classify_row_span(row)
    return found[0] if found else None


def _classify_row_span(row: str) -> tuple[str, int] | None:
    """(row kind, column where its label ends), or None."""
    # Only the label portion (first _LABEL_END chars) matters for classification
    label = row[:_LABEL_END + 5]  # +5 for multi-word labels like "Wind gust"
    for kind, pattern in _ROW_PATTERNS.items():
        m = pattern.match(label)
        if m:
            return kind, m.end()
    return None


def _table_columns(local_line: str, m_local, utc_line: str, m_utc, n: int,
                   rows: list[str]) -> list[int]:
    """The data columns of a table with `n` UTC hours.

    Either hour header can sit off the data: one glued to its label
    ("UTC 6hrly06 12 18", "MDT 6hrly00   06 12") starts left of it, and
    "UTC3hrly     09 12" (MHX) one column left. So each header's columns, read
    from where its hours start and from column 14, are tried, and the set on
    which most of the table's values end wins (values are right-aligned on a
    column). Ties go to the UTC row, then to reading from column 14, as
    before; with no candidate of `n` columns, the old reading."""
    candidates: list[list[int]] = []
    for line, m in ((utc_line, m_utc), (local_line, m_local)):
        for start in (_LABEL_END, m.start("hours")):
            cols = _find_column_positions(line, start)
            if len(cols) == n and cols not in candidates:
                candidates.append(cols)
    if not candidates:
        cols = _find_column_positions(utc_line, _LABEL_END)
        if len(cols) != n:
            # Misaligned — fall back to the local hrly line
            cols = _find_column_positions(local_line, _LABEL_END)
        return cols
    if len(candidates) == 1:
        return candidates[0]
    ends: list[int] = []
    for row in rows:
        found = _classify_row_span(row)
        if found is None or (found[1] < len(row) and not row[found[1]].isspace()):
            continue
        ends += [m.end() - 1 for m in re.finditer(r"\S+", row) if m.start() >= found[1]]

    def score(cols: list[int]) -> int:
        at = {p + 1 for p in cols}
        return sum(e in at for e in ends)

    return max(candidates, key=score)   # max keeps the first of equals


_VALUE_TOKEN_RE = re.compile(r"^(?:-?\d+(?:\.\d+)?|[A-Z][A-Z0-9]{0,2})$")


def _twelve_hourly_columns(rows: list[str], positions: list[int], utc_hours: list[int]) -> set[int]:
    """Columns (indexes) holding a table's 12-hourly values (PoP, QPF,
    Min/Max): where its rows of those that are not glued have them, else the
    00Z and 12Z columns (Hawaii's sit at 06Z and 18Z, so the rows decide)."""
    col_at_end = {p + 1: k for k, p in enumerate(positions)}
    cols: set[int] = set()
    for row in rows:
        found = _classify_row_span(row)
        if found is None or found[0] not in _TWELVE_HOURLY:
            continue
        if found[1] < len(row) and not row[found[1]].isspace():
            continue
        for m in re.finditer(r"\S+", row[found[1]:]):
            k = col_at_end.get(found[1] + m.end() - 1)
            if k is not None:
                cols.add(k)
    return cols or {k for k, h in enumerate(utc_hours) if h in (0, 12)}


def _unglue_row(row: str, label_end: int, positions: list[int],
                anchor_cols: set[int] | None = None) -> str | None:
    """Rebuild a row whose first value is glued to its label ("Temp52 49 43",
    "PoP 12hr0           0", "Max/Min70          47") with its values on the
    table's columns. Only the spaces before the first value are lost; the
    values keep their spacing among themselves. They are placed as far right
    as they go with every value ending on a column (a Temp row runs to the
    table's last column), and a 12-hourly row's values (PoP, QPF, Min/Max)
    on `anchor_cols` when they fit there. None when they cannot be placed."""
    rest = row[label_end:]
    toks = [(m.start(), m.end() - 1, m.group()) for m in re.finditer(r"\S+", rest)]
    if not toks or not all(_VALUE_TOKEN_RE.match(t) for _, _, t in toks):
        return None
    col_at_end = {p + 1: k for k, p in enumerate(positions)}

    def place(anchors: set[int] | None) -> int | None:
        for p in reversed(positions):
            base = p + 1 - toks[-1][1]          # column of rest[0] once re-spaced
            if base <= label_end:
                return None
            ks = [col_at_end.get(base + end) for _, end, _ in toks]
            if any(k is None for k in ks):
                continue
            if anchors is not None and not all(k in anchors for k in ks):
                continue
            return base
        return None

    base = place(anchor_cols) if anchor_cols else None
    if base is None:
        base = place(None)
    if base is None:
        return None
    out = list(row[:label_end].ljust(base + toks[-1][1] + 1))
    for start, _end, tok in toks:
        out[base + start:base + start + len(tok)] = tok
    return "".join(out)


def _apply_row(kind: str, row: str, positions: list[int], slots: list[PFMSlot]) -> None:
    """Apply a data row's values to the matching slot fields."""
    values = [_extract_slot_value(row, pos) for pos in positions]
    for slot, val in zip(slots, values):
        if not val:
            continue
        if kind == "temp":
            n = _parse_int(val)
            if n is not None:
                slot.temp_f = n
        elif kind == "dewpt":
            n = _parse_int(val)
            if n is not None:
                slot.dewpt_f = n
        elif kind == "rh":
            n = _parse_int(val)
            if n is not None:
                slot.rh_pct = n
        elif kind in ("wind_dir", "pwind_dir"):
            slot.wind_dir = val
        elif kind == "wind_spd":
            n = _parse_int(val)
            if n is not None:
                slot.wind_spd_mph = n
        elif kind == "wind_gust":
            n = _parse_int(val)
            if n is not None:
                slot.wind_gust_mph = n
        elif kind == "clouds":
            slot.cloud = val
        elif kind == "pop12":
            n = _parse_int(val)
            if n is not None:
                slot.pop_pct = n
        elif kind == "qpf12":
            f = _parse_float(val)
            if f is not None:
                slot.qpf_in = f
        elif kind == "rain":
            slot.rain = val
        elif kind == "tstm":
            slot.tstm = val
        elif kind == "obvis":
            slot.obvis = val
        elif kind in ("min_max", "max_min"):
            n = _parse_int(val)
            if n is not None:
                slot.minmax_f = n
        # snow12 and wind_char are not applied.


# -- Utilities ----------------------------------------------------------------


def find_point(points: list[PFMPoint], name: str = "", zone: str = "") -> PFMPoint | None:
    """Locate a specific point by name or by UGC zone code."""
    for p in points:
        if zone and p.zone == zone:
            return p
        if name and p.name == name:
            return p
    return None


# -- Daily downsampler → 0x31 periods -----------------------------------------

# Sky code nibbles (match meshcore_weather.protocol.meshwx SKY_*). We
# can't import from protocol here without creating a cycle, so these are
# duplicated. Keep in sync with meshwx.py.
_SKY_CLEAR = 0x0
_SKY_FEW = 0x1
_SKY_SCATTERED = 0x2
_SKY_BROKEN = 0x3
_SKY_OVERCAST = 0x4
_SKY_FOG = 0x5
_SKY_RAIN = 0x8
_SKY_SNOW = 0x9
_SKY_THUNDERSTORM = 0xA

# PFM cloud codes → sky nibble. CL=clear, FW=few, SC=scattered, B1/B2=broken,
# OV=overcast. Source: NWS PFM format spec.
_CLOUD_TO_SKY = {
    "CL": _SKY_CLEAR,
    "FW": _SKY_FEW,
    "SC": _SKY_SCATTERED,
    "B1": _SKY_BROKEN,
    "B2": _SKY_BROKEN,
    "OV": _SKY_OVERCAST,
}

# 16-point compass → nibble (match wind_dir_to_nibble in meshwx.py)
_COMPASS_TO_NIBBLE = {
    "N": 0, "NNE": 1, "NE": 2, "ENE": 3,
    "E": 4, "ESE": 5, "SE": 6, "SSE": 7,
    "S": 8, "SSW": 9, "SW": 10, "WSW": 11,
    "W": 12, "WNW": 13, "NW": 14, "NNW": 15,
}

# Condition flag bits (match encode_forecast_from_zfp in encoders.py)
_COND_THUNDER = 0x01
_COND_FROST = 0x02
_COND_FOG = 0x04
_COND_HIGH_WIND = 0x08
_COND_FREEZING_RAIN = 0x10
_COND_HEAVY_RAIN = 0x20
_COND_HEAVY_SNOW = 0x40


def _derive_sky_code(slot: PFMSlot) -> int:
    """Map a single slot's weather codes to a 4-bit sky nibble.

    Precedence: thunderstorm > rain > snow > fog > cloud cover.
    This way a "partly cloudy with thunderstorms" slot gets the TSTM
    code which is the most actionable thing to display.
    """
    if slot.tstm and slot.tstm in ("C", "L", "D"):
        return _SKY_THUNDERSTORM
    if slot.rain and slot.rain in ("C", "L", "D"):
        return _SKY_RAIN
    if slot.obvis == "BS":
        return _SKY_SNOW
    if slot.obvis in ("F", "PF"):
        return _SKY_FOG
    return _CLOUD_TO_SKY.get(slot.cloud, _SKY_CLEAR)


def _derive_condition_flags(slots: list[PFMSlot]) -> int:
    """OR together condition flag bits from all slots in a period."""
    flags = 0
    for s in slots:
        if s.tstm and s.tstm in ("C", "L", "D"):
            flags |= _COND_THUNDER
        if s.obvis in ("F", "PF"):
            flags |= _COND_FOG
        if s.obvis == "BS":
            flags |= _COND_HEAVY_SNOW
        # Heavy rain: PoP ≥ 70 AND rain likely/definite
        if s.pop_pct is not None and s.pop_pct >= 70 and s.rain in ("L", "D"):
            flags |= _COND_HEAVY_RAIN
        if s.qpf_in is not None and s.qpf_in >= 1.0:
            flags |= _COND_HEAVY_RAIN
        # High wind: sustained ≥ 30 mph OR gusts ≥ 40 mph
        if s.wind_spd_mph is not None and s.wind_spd_mph >= 30:
            flags |= _COND_HIGH_WIND
        if s.wind_gust_mph is not None and s.wind_gust_mph >= 40:
            flags |= _COND_HIGH_WIND
        # Frost: low temp ≤ 36°F (overnight)
        if s.temp_f is not None and s.temp_f <= 36:
            flags |= _COND_FROST
        # Freezing rain / sleet
        if s.obvis in ("IP", "ZR", "ZL"):
            flags |= _COND_FREEZING_RAIN
    return flags


def _dominant_sky(slots: list[PFMSlot]) -> int:
    """Return the most severe sky condition across the slots (precip > clouds)."""
    if not slots:
        return _SKY_CLEAR
    codes = [_derive_sky_code(s) for s in slots]
    # Precedence — pick the highest-priority code that appears
    for priority in (_SKY_THUNDERSTORM, _SKY_RAIN, _SKY_SNOW, _SKY_FOG,
                     _SKY_OVERCAST, _SKY_BROKEN, _SKY_SCATTERED, _SKY_FEW, _SKY_CLEAR):
        if priority in codes:
            return priority
    return _SKY_CLEAR


def _dominant_wind_dir(slots: list[PFMSlot]) -> int:
    """Return the most common wind direction nibble across the slots."""
    from collections import Counter
    dirs = [s.wind_dir for s in slots if s.wind_dir]
    if not dirs:
        return 0
    most_common = Counter(dirs).most_common(1)[0][0]
    return _COMPASS_TO_NIBBLE.get(most_common, 0)


def _avg_wind_speed_5mph(slots: list[PFMSlot]) -> int:
    """Return the average wind speed in 5 mph buckets (0-15)."""
    speeds = [s.wind_spd_mph for s in slots if s.wind_spd_mph is not None]
    if not speeds:
        return 0
    avg = sum(speeds) / len(speeds)
    return max(0, min(15, int(round(avg / 5))))


@dataclass
class DailyPeriod:
    """One daily forecast period derived from PFM slots. Mirrors the 0x31 period dict."""
    day_offset: int        # 0 = first local date in the data, 1 = next, etc.
    local_date: object     # datetime.date of this period (the single source of truth for labels)
    high_f: int | None
    low_f: int | None
    sky_code: int
    precip_pct: int
    wind_dir_nibble: int
    wind_speed_5mph: int
    condition_flags: int

    def to_encoder_dict(self) -> dict:
        """Return a dict compatible with meshwx.pack_forecast()."""
        return {
            "period_id": self.day_offset,
            "high_f": 127 if self.high_f is None else self.high_f,
            "low_f": 127 if self.low_f is None else self.low_f,
            "sky_code": self.sky_code,
            "precip_pct": self.precip_pct,
            "wind_dir_nibble": self.wind_dir_nibble,
            "wind_speed_5mph": self.wind_speed_5mph,
            "condition_flags": self.condition_flags,
        }


def downsample_to_daily(
    point: PFMPoint, max_days: int = 7, min_slots_per_day: int = 4
) -> list[DailyPeriod]:
    """Aggregate a PFMPoint's 3-hourly + 6-hourly slots into daily periods.

    Grouping is by LOCAL calendar date (using the point's tz_offset_hours).
    Day 0 is the first local date that has at least `min_slots_per_day`
    temperature readings — this skips partial days at the start/end of
    the PFM window that would otherwise produce misleading aggregates
    (e.g. a "high" equal to an early-morning temp because the afternoon
    slots aren't in the PFM yet).

    For each day:
      high_f        = the Min/Max row's daytime value (evening column) when the
                      product has one — it is the forecast max, which the
                      3-hourly Temp samples miss by several degrees — else
                      max Temp across daytime slots (local hour 6-18)
      low_f         = the Min/Max row's overnight value at the next morning
                      (the night that follows this day) when present, else
                      min Temp across nighttime slots
      sky_code      = most severe weather condition during daytime
      precip_pct    = max 12hr PoP value that falls inside the day
      wind_dir_nibble = most common direction during daytime
      wind_speed_5mph = average sustained wind speed during daytime
      condition_flags = OR of flags from all slots in the day

    Invariant: for every returned period, `high_f >= low_f`.
    """
    if not point.slots:
        return []

    # Group slots by local date
    from collections import defaultdict
    by_local_date: dict[date, list[PFMSlot]] = defaultdict(list)
    for s in point.slots:
        by_local_date[point.local_date(s.dt)].append(s)

    # Filter to days with enough data. We keep contiguous runs starting
    # from the first day with enough data, so we don't have gaps in the
    # middle of the series.
    sorted_dates = sorted(by_local_date.keys())

    def row_max(d: date) -> list[int]:
        """The Min/Max row's daytime value(s) for day d (the evening column)."""
        return [s.minmax_f for s in by_local_date.get(d, [])
                if s.minmax_f is not None and point.local_hour(s.dt) >= 12]

    def row_min_after(d: date) -> list[int]:
        """The Min/Max row's overnight value after day d (next morning)."""
        return [s.minmax_f for s in by_local_date.get(d + timedelta(days=1), [])
                if s.minmax_f is not None and point.local_hour(s.dt) < 12]

    valid_dates: list[date] = []
    for d in sorted_dates:
        temps = [s.temp_f for s in by_local_date[d] if s.temp_f is not None]
        # A day counts when it has enough samples, or when NWS gave its
        # max in the Min/Max row (issued late in the day, "today" has only
        # evening samples but the row still says what the high was/is). A
        # day whose Temp row could not be read still counts when the Min/Max
        # row gives both its high and the night's low.
        has_row_max = bool(row_max(d))
        if len(temps) >= min_slots_per_day or (has_row_max and (temps or row_min_after(d))):
            valid_dates.append(d)
        elif valid_dates:
            # We've hit a partial day AFTER finding valid ones — stop here
            # rather than emitting a truncated last day with bogus aggregates.
            break

    if not valid_dates:
        return []
    base_date = valid_dates[0]

    periods: list[DailyPeriod] = []
    for d in valid_dates[:max_days]:
        day_slots = by_local_date[d]
        daytime = [s for s in day_slots if 6 <= point.local_hour(s.dt) <= 18]
        nighttime = [s for s in day_slots
                     if point.local_hour(s.dt) < 6 or point.local_hour(s.dt) > 18]

        daytime_temps = [s.temp_f for s in daytime if s.temp_f is not None]
        night_temps = [s.temp_f for s in nighttime if s.temp_f is not None]
        all_temps = [s.temp_f for s in day_slots if s.temp_f is not None]

        high_f = (max(daytime_temps) if daytime_temps else max(all_temps)) if all_temps else None
        low_f = (min(night_temps) if night_temps else min(all_temps)) if all_temps else None
        # Prefer the forecast's own Min/Max row (and it is all there is when
        # the Temp row was unusable).
        day_max = row_max(d)
        if day_max:
            high_f = max(day_max)
        night_min = row_min_after(d)
        if night_min:
            low_f = min(night_min)
        if high_f is None or low_f is None:
            break
        if low_f > high_f:
            low_f, high_f = high_f, low_f

        # Sky/wind derivations prefer daytime values; fall back to whole day.
        sky_src = daytime if daytime else day_slots
        sky_code = _dominant_sky(sky_src)
        wind_dir_nibble = _dominant_wind_dir(sky_src)
        wind_speed_5mph = _avg_wind_speed_5mph(sky_src)

        # Max PoP 12hr across any slot that has one
        pops = [s.pop_pct for s in day_slots if s.pop_pct is not None]
        precip_pct = max(pops) if pops else 0

        # Condition flags aggregated over the whole day
        flags = _derive_condition_flags(day_slots)

        periods.append(
            DailyPeriod(
                day_offset=(d - base_date).days,
                local_date=d,
                high_f=high_f,
                low_f=low_f,
                sky_code=sky_code,
                precip_pct=precip_pct,
                wind_dir_nibble=wind_dir_nibble,
                wind_speed_5mph=wind_speed_5mph,
                condition_flags=flags,
            )
        )

    return periods
