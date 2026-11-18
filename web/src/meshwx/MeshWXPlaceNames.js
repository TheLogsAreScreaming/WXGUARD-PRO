// Port of MC1Services/Sources/MeshWX/MeshWXPlaceNames.swift
//
// MARK: - Place labels (spec §16.2)
//
// How a bundle place name is shown: the rule of spec §16.2, which the weather bot's text replies
// follow too (`meshcore_weather/geodata/names.py`), so a town or a ZIP reads the same texted to
// the bot as shown in the app: "Hell's Kitchen, NY 10019", "Adjuntas, PR", "McGuire AFB, NJ".
//
// Works on Unicode code points, as the bot works on code points: letters are general category L,
// digits Nd, and case changes are each code point's full mapping.

const LETTER = /\p{L}/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

export const MeshWXPlaceNames = Object.freeze({
  /**
   * Census legal and statistical descriptors nobody says, removed from the end of a name in
   * this order, each at most once, with the spaces and commas left in front of them.
   */
  suffixes: Object.freeze([
    ' CITY (BALANCE)', ' (BALANCE)', ' (HISTORICAL)', ' (VILLAGE)',
    ' CONSOLIDATED GOVERNMENT', ' METROPOLITAN GOVERNMENT', ' METRO GOVERNMENT',
    ' UNIFIED GOVERNMENT', ' URBAN COUNTY', ' METRO TOWNSHIP',
    ' ZONA URBANA', ' COMUNIDAD', ' COLONIA', ' MUNICIPIO', ' CDP', ' CITY AND', ' URBAN',
  ]),

  /**
   * Words kept in capitals. State codes are not among them: in place names LA, DE, IN, HI and
   * OR are words ("La Grange", "De Queen", "Valley Hi"), and DC, the one real code, is listed.
   */
  initialisms: new Set([
    'AFB', 'AAF', 'ARB', 'ANGB', 'NAS', 'NAF', 'NOLF', 'MCAS', 'USCG', 'MCBH', 'WMATA',
    'DC', 'NE', 'NW', 'SE', 'SW', 'VA', 'UC', 'KC', 'II', 'III',
  ]),

  /** Joining words, lower case anywhere but first: "Lake of the Woods", "Marina del Rey". */
  particles: new Set(['OF', 'THE', 'IN', 'ON', 'AT', 'BY', 'AND', 'OR', 'DE', 'DEL', 'DU']),

  /** Apostrophes and the Hawaiian ʻokina with its stand-ins: part of a word, not between words. */
  marks: new Set(["'", '’', '‘', 'ʻ', '`']),

  /** `"Austin, TX"` for a `places.json` entry; `"Austin, TX 78701"` with a ZIP. */
  label({ name, state, zip = null }) {
    const label = `${MeshWXPlaceNames.placeName(name)}, ${state}`;
    return zip == null ? label : `${label} ${zip}`;
  },

  /** `"ADJUNTAS ZONA URBANA"` → `"Adjuntas"`: the suffixes dropped, then title cased. */
  placeName(name) {
    let scalars = upperScalars(name);
    for (const suffix of MeshWXPlaceNames.suffixes) {
      const tail = [...suffix];
      if (scalars.length < tail.length) continue;
      const end = scalars.slice(scalars.length - tail.length);
      if (!end.every((scalar, index) => scalar === tail[index])) continue;
      scalars = scalars.slice(0, scalars.length - tail.length);
      while (scalars.length > 0) {
        const last = scalars[scalars.length - 1];
        if (last !== ' ' && last !== ',') break;
        scalars.pop();
      }
    }
    return titleCasedScalars(scalars, {});
  },

  /**
   * Any casing in, the same out: `"HELL'S KITCHEN"` → "Hell's Kitchen", `"CENTRAL 14TH STREET"`
   * → "Central 14th Street", `"MCGUIRE AFB"` → "McGuire AFB", `"‘EWA"` → "‘Ewa".
   *
   * A word is a run of letters, digits and `marks`; anything else is kept as it is between
   * words. A word in `expanding` becomes its expansion; one in `initialisms` or `keepingUpper`
   * stays in capitals; one of the `particles` after the first word is lower case. Otherwise
   * every letter is lower case except the first character, the one after a leading "MC", and one
   * right after a mark that starts the word or follows its one-letter start (O'Fallon).
   *
   * Place labels pass nothing extra; station names keep state codes and expand aviation
   * abbreviations.
   */
  titleCased(text, { keepingUpper = new Set(), expanding = {} } = {}) {
    return titleCasedScalars(upperScalars(text), { keepingUpper, expanding });
  },
});

function upperScalars(text) {
  const out = [];
  for (const scalar of String(text)) out.push(...scalar.toUpperCase());
  return out;
}

function lowerScalars(scalars) {
  const out = [];
  for (const scalar of scalars) out.push(...scalar.toLowerCase());
  return out;
}

function isLetter(scalar) {
  if (MeshWXPlaceNames.marks.has(scalar)) return false;
  return LETTER.test(scalar);
}

function isWordScalar(scalar) {
  return MeshWXPlaceNames.marks.has(scalar) || isLetter(scalar) || DECIMAL_DIGIT.test(scalar);
}

function titleCasedScalars(scalars, { keepingUpper = new Set(), expanding = {} } = {}) {
  let result = '';
  let index = 0;
  let isFirstWord = true;
  while (index < scalars.length) {
    if (!isWordScalar(scalars[index])) {
      result += scalars[index];
      index += 1;
      continue;
    }
    let end = index;
    while (end < scalars.length && isWordScalar(scalars[end])) end += 1;
    const word = scalars.slice(index, end);
    const upper = word.join('');
    if (Object.hasOwn(expanding, upper)) {
      result += expanding[upper];
    } else if (MeshWXPlaceNames.initialisms.has(upper) || keepingUpper.has(upper)) {
      result += upper;
    } else if (!isFirstWord && MeshWXPlaceNames.particles.has(upper)) {
      result += lowerScalars(word).join('');
    } else {
      for (let offset = 0; offset < word.length; offset += 1) {
        const scalar = word[offset];
        if (!isLetter(scalar)) {
          result += scalar;
          continue;
        }
        const capital = offset === 0
          || (offset === 2 && word[0] === 'M' && word[1] === 'C')
          || (MeshWXPlaceNames.marks.has(word[offset - 1])
            && (offset === 1 || (offset === 2 && isLetter(word[0]))));
        result += capital ? scalar : lowerScalars([scalar]).join('');
      }
    }
    isFirstWord = false;
    index = end;
  }
  return result;
}
