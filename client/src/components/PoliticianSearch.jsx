import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../api.js';
import { IconSearch } from './icons.jsx';
import {
  SEARCH_DEBOUNCE_MS,
  personSuggestionMeta,
  searchKeyAction,
  tickerSymbol,
  tradeCountLabel,
} from '../politicianSearch.js';

export default function PoliticianSearch({ onPerson, onTicker }) {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listId = `${reactId}-list`;
  const hintId = `${reactId}-hint`;
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [settledFor, setSettledFor] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const trimmed = q.trim();

  useEffect(() => {
    setPeople([]);
    setSettledFor('');
    setActive(-1);
    setFailed(false);
    if (trimmed.length < 2) {
      setBusy(false);
      setOpen(Boolean(tickerSymbol(trimmed, { hasPeople: false, settled: true })));
      return undefined;
    }
    setBusy(true);
    setOpen(true);
    let cancel = false;
    const timer = setTimeout(() => {
      api.politicianPeople(trimmed)
        .then((body) => {
          if (cancel) return;
          setPeople(Array.isArray(body?.people) ? body.people : []);
          setSettledFor(trimmed);
          setFailed(false);
          setOpen(true);
        })
        .catch(() => {
          if (cancel) return;
          setPeople([]);
          setSettledFor(trimmed);
          setFailed(true);
        })
        .finally(() => {
          if (!cancel) setBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const settled = settledFor === trimmed;
  const symbol = tickerSymbol(trimmed, { hasPeople: people.length > 0, settled });
  const options = useMemo(() => {
    const rows = people.map((person) => ({
      kind: 'person',
      key: person.personKey,
      person,
    }));
    if (symbol) rows.push({ kind: 'ticker', key: `ticker:${symbol}`, symbol });
    return rows;
  }, [people, symbol]);

  useEffect(() => {
    setActive((index) => (index >= options.length ? -1 : index));
  }, [options.length]);

  function pick(option) {
    if (!option) return;
    setOpen(false);
    setActive(-1);
    setQ('');
    if (option.kind === 'ticker') onTicker(option.symbol);
    else onPerson(option.person.personKey);
  }

  function onKeyDown(event) {
    const action = searchKeyAction({
      key: event.key,
      options,
      activeIndex: active,
      open,
    });
    if (!action) return;
    event.preventDefault();
    setOpen(action.open);
    setActive(action.activeIndex);
    if (action.activate) pick(action.activate);
  }

  const showList = open && (busy || failed || options.length > 0 || (settled && trimmed.length >= 2));
  const activeId = active >= 0 ? `${listId}-opt-${active}` : undefined;
  const status = failed
    ? 'Search failed. Try again.'
    : busy
      ? 'Searching…'
      : settled && trimmed.length >= 2
        ? `${people.length} politician${people.length === 1 ? '' : 's'}`
        : '';

  return (
    <div className="ptr-search">
      <label className="ptr-search-label" htmlFor={inputId}>Find a politician</label>
      <div className="ptr-search-box">
        <span className="ptr-search-icon" aria-hidden="true"><IconSearch /></span>
        <input
          id={inputId}
          className="ptr-search-input"
          role="combobox"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Nancy Pelosi or AAPL"
          value={q}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList ? activeId : undefined}
          aria-describedby={hintId}
          aria-busy={busy}
          onChange={(event) => setQ(event.target.value)}
          onFocus={() => {
            if (trimmed) setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        {trimmed && (
          <button
            type="button"
            className="ptr-search-clear"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQ('');
              setOpen(false);
              document.getElementById(inputId)?.focus();
            }}
          >Clear</button>
        )}
        {showList && (
          <ul id={listId} className="ptr-search-list" role="listbox" aria-label="Politicians">
            {options.map((option, index) => {
              const selected = index === active;
              if (option.kind === 'ticker') {
                return (
                  <li key={option.key} role="presentation">
                    <div
                      id={`${listId}-opt-${index}`}
                      role="option"
                      aria-selected={selected}
                      className="ptr-search-opt"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pick(option);
                      }}
                      onMouseEnter={() => setActive(index)}
                    >
                      <span className="ptr-search-name">Show trades in {option.symbol}</span>
                      <span className="ptr-search-meta">Open the filings filtered to this ticker</span>
                    </div>
                  </li>
                );
              }
              const meta = personSuggestionMeta(option.person);
              return (
                <li key={option.key} role="presentation">
                  <div
                    id={`${listId}-opt-${index}`}
                    role="option"
                    aria-selected={selected}
                    className="ptr-search-opt"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <span className="ptr-search-top">
                      <span className="ptr-search-name">{option.person.personName}</span>
                      <span className="ptr-search-count">{tradeCountLabel(option.person.tradeCount)}</span>
                    </span>
                    {meta && <span className="ptr-search-meta">{meta}</span>}
                  </div>
                </li>
              );
            })}
            {busy && !options.length && (
              <li className="ptr-search-empty" role="presentation">Searching…</li>
            )}
            {!busy && !options.length && settled && (
              <li className="ptr-search-empty" role="presentation">
                {failed ? 'Search failed. Try again.' : `No politicians match “${trimmed}”.`}
              </li>
            )}
          </ul>
        )}
      </div>
      <p id={hintId} className={`ptr-search-hint${showList ? ' ptr-sr' : ''}`}>
        Type a name. Suggestions match the first or last name. Enter opens the only match.
      </p>
      <p className="ptr-sr" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
