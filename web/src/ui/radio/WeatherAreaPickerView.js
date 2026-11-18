// The state picker the alert map's "Areas to ask for" row opens (docs/MESHWX_UI.md §17).
//
// Owner, 20 September 2026: *"…have a way for the user to select which areas they want to request
// the warnings for. One, a few, or all. That way we don't default to sending everything."*
//
// So it is a multi-select of states with the whole country at the top, and every tap is saved as
// it is made (`model.setAreaSelection`) rather than on a Done button: the selection is a thing the
// device holds (`WeatherAreaSelection`), and a list that only commits on the way out loses the
// pick to a back gesture.
//
// It asks for nothing. Nothing on this screen reaches the radio; the ask is one screen back, and
// it says what it costs before it is tapped.
import { h } from '../kit/dom.js'
import { Card, List, Note } from '../kit/components.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { WeatherAreaSelection } from '../../screen/index.js'
import { WeatherReferenceNames } from '../../app/index.js'
import { safeScreen } from './support.js'

/**
 * `WeatherAreaPickerScreen({ app, page })` — pushed from the alert map, and bound to **that**
 * page: the default selection is the state of the page's own place, so the screen has to be
 * reading the page it was opened from and never the model's current one (§3.1 P-1).
 */
export function WeatherAreaPickerScreen({ app, page }) {
  // Screen-local, in the closure: the search box is a filter over 55 rows, not a thing the model
  // needs to know about (docs/UI_KIT.md).
  const state = { query: '', input: null }
  const pageID = page?.pageID ?? null

  const selection = () => app.model?.areaSelection?.({ pageID }) ?? WeatherAreaSelection.wholeCountry

  const save = (next) => {
    app.model?.setAreaSelection?.(next)
    app.nav.refresh()
  }

  /**
   * Every state a `>wmap` may name, sorted by name, with this page's own state lifted to the top.
   *
   * The codes come from `index.json` `states` — the table the wire indexes into — so a code this
   * app could not send is never offered.
   */
  const allStates = () => WeatherReferenceNames.requestableStates(app.tables?.states ?? [])

  const homeState = () => {
    const code = page?.context?.placeStateCode ?? null
    if (code == null) return null
    return allStates().includes(code) ? code : null
  }

  const matches = (code) => {
    const query = state.query.trim().toLowerCase()
    if (query === '') return true
    return code.toLowerCase().startsWith(query)
      || WeatherReferenceNames.stateName(code).toLowerCase().includes(query)
  }

  /** A row that toggles. A real button with `aria-pressed`, so the state is spoken, not implied. */
  const toggleRow = ({ key, title, subtitle = null, isOn, onclick }) => h('button', {
    class: ['row', 'pick-row'],
    type: 'button',
    key,
    'aria-pressed': isOn ? 'true' : 'false',
    onclick,
  },
  h('span', { class: 'row__main' },
    h('span', { class: 'row__title' }, title),
    subtitle != null ? h('span', { class: 'row__subtitle' }, subtitle) : null),
  h('span', { class: 'row__check pick-row__check' },
    isOn ? icon('checkmark', { size: 18 }) : null))

  const searchField = () => h('div', { class: 'search' },
    h('input', {
      type: 'search',
      key: 'state-search',
      'data-static': '',
      enterkeyhint: 'search',
      autocomplete: 'off',
      'aria-label': t('weather.areaMap.pickerSearch'),
      placeholder: t('weather.areaMap.pickerSearch'),
      hook: (element) => {
        state.input = element
        const onInput = () => { state.query = element.value; app.nav.refresh() }
        element.addEventListener('input', onInput)
        return () => { element.removeEventListener('input', onInput); state.input = null }
      },
    }),
    state.query !== ''
      ? h('button', {
        class: 'search__clear',
        type: 'button',
        'aria-label': t('web.place.clearSearch'),
        onclick: () => {
          if (state.input != null) state.input.value = ''
          state.query = ''
          app.nav.refresh()
        },
      }, h('span', { 'aria-hidden': 'true' }, '×'))
      : null)

  return safeScreen({
    id: 'area-picker',
    title: () => t('weather.areaMap.areasToAsk'),
    render() {
      const picked = selection()
      const home = homeState()
      const rest = allStates().filter((code) => code !== home)
      const shown = rest.filter(matches)
      const showsHome = home != null && matches(home)
      const count = picked.isWholeCountry ? 0 : picked.states.length

      return List(
        searchField(),

        // The whole country first, because it is the answer for anyone who does not want to
        // think about states at all — and because picking it is what clears the list below.
        Card({ key: 'all' },
          toggleRow({
            key: 'whole-country',
            title: t('weather.areaMap.pickerWholeCountry'),
            isOn: picked.isWholeCountry,
            onclick: () => save(WeatherAreaSelection.wholeCountry),
          })),

        // One card, so the count in its label is the count of everything in it. This page's own
        // state is its first row rather than a card of its own: a phone that opens the map during
        // a storm is asking about where it is, and scrolling to W for Wyoming is not that.
        Card({
          label: t('weather.areaMap.pickerEveryState'),
          labelTrailing: count > 0 ? t('weather.areaMap.pickerSelected', count) : null,
          key: 'states',
        },
        showsHome
          ? toggleRow({
            key: home,
            title: WeatherReferenceNames.stateName(home),
            subtitle: t('weather.areaMap.pickerYourState'),
            isOn: !picked.isWholeCountry && picked.states.includes(home),
            onclick: () => save(WeatherAreaSelection.toggling(picked, { state: home })),
          })
          : null,
        shown.length === 0 && !showsHome
          ? Note(t('weather.areaMap.pickerNoMatches'))
          : shown.map((code) => toggleRow({
            key: code,
            title: WeatherReferenceNames.stateName(code),
            isOn: !picked.isWholeCountry && picked.states.includes(code),
            onclick: () => save(WeatherAreaSelection.toggling(picked, { state: code })),
          }))),

        // Past fifteen codes the request does not fit and the tap asks for the country instead.
        // Said here as well as on the map, because this is the screen where the sixteenth is
        // picked (spec §14, revision 10).
        count > WeatherAreaSelection.maxStates
          ? Note(t('weather.areaMap.tooManyStates', WeatherAreaSelection.maxStates))
          : null,
      )
    },
  })
}
