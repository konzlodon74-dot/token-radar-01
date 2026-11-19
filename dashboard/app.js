// Launchscope's page. It renders window.RADAR, the dataset main.ts writes beside this page
// from the same board it hands in: the board table, one detail page per protocol with the
// pricing breakdown and the farm plan, and the live peer set shown apart. No fetch, no
// network: everything the page shows was computed by the model in lib/model.ts, and the
// farm steps below are the board's own strings, so the page and board.json cannot drift.
//
// Routes live in the hash so any view can be linked and captured:
//   #/                 the board          #/?cat=Lending&watch=1   a filtered board
//   #/live             already trading    #/p/<slug>               a protocol's detail

const D = window.RADAR;
const rows = D.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** $2.75B, $150M, $12.4K: compact money for tables. */
function fmtUSD(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}
/** $2,750,000,000: whole money for the detail page. */
const fmtFull = (n) => `$${n.toLocaleString('en-US')}`;
/** +5.6% / -2.2%, or a dash when the snapshot reports no change. */
function fmtChange(c) {
  if (c === null) return '<span class="flat" title="Not reported in the snapshot">—</span>';
  const cls = c > 0 ? 'pos' : c < 0 ? 'neg' : 'flat';
  return `<span class="${cls}">${c > 0 ? '+' : ''}${c.toFixed(1)}%</span>`;
}
/** 214 d, 7 mo, 2.9 yrs, or a dash when no listing date is reported. */
function fmtAge(days) {
  if (days === null) return '<span class="flat" title="Listing date not reported">—</span>';
  if (days < 60) return `${days} d`;
  if (days < 730) return `${Math.round(days / 30.4)} mo`;
  return `${(days / 365.25).toFixed(1)} yrs`;
}
const fmtMult = (n) => `${n.toFixed(n < 0.1 ? 3 : 2)}x`;
const fmtFactor = (n) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');

// ------------------------------------------------------------------ header + stats

$('asof').textContent = D.as_of;
$('source').textContent = D.source;
$('globalMult').textContent = fmtMult(D.global_multiple);
$('globalPeers').textContent = String(D.global_peers);

$('stats').innerHTML = [
  [String(D.scanned), 'protocols in the snapshot'],
  [String(D.pre_token), 'record no token yet'],
  [`<em>${D.board_size}</em>`, `ranked on the board (${D.early_size} early finds)`],
  [`<em>${D.watchlist_size}/${D.watchlist_size}</em>`, 'watchlist slugs covered'],
  [fmtUSD(Math.max(...rows.map((r) => r.implied_value_usd))), 'largest implied value'],
]
  .map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`)
  .join('');

// ------------------------------------------------------------------ the board

const state = { q: '', cat: '', chain: '', watch: false, hideRisk: false, sort: 'rank', dir: 1 };

const catSel = $('cat');
for (const c of [...new Set(rows.map((r) => r.category ?? 'Uncategorised'))].sort()) {
  catSel.insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);
}
const chainSel = $('chain');
for (const c of [...new Set(rows.flatMap((r) => r.chains))].sort()) {
  chainSel.insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);
}

const SORTS = {
  rank: (r) => r.rank,
  name: (r) => r.name.toLowerCase(),
  tvl: (r) => r.tvl_usd,
  change: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
  age: (r) => (r.age_days === null ? -1 : r.age_days),
  multiple: (r) => r.model.peer_multiple,
  implied: (r) => r.implied_value_usd,
  score: (r) => r.launch_score,
};

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let out = rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    if (state.cat && (r.category ?? 'Uncategorised') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.watch && !r.on_watchlist) return false;
    if (state.hideRisk && r.risk_flags.some((f) => f.startsWith('product risk'))) return false;
    return true;
  });
  const key = SORTS[state.sort] ?? SORTS.rank;
  out = [...out].sort((a, b) => {
    const d = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.rank - b.rank;
    return d * state.dir;
  });
  return out;
}

function rowHTML(r) {
  const flags = r.risk_flags.length
    ? `<span class="flagdot" title="${esc(r.risk_flags.join(' · '))}">${r.risk_flags.length}</span>`
    : '<span class="noflag">—</span>';
  const chains = r.chains.length === 0 ? '—' : `${r.chains.length} · ${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? '…' : ''}`;
  return `<tr class="row" data-slug="${esc(r.slug)}">
    <td class="rank">${r.rank}</td>
    <td class="name"><a class="nm" href="#/p/${esc(r.slug)}">${esc(r.name)}</a><span class="slug">${esc(r.slug)}</span>${
      r.on_watchlist ? '<span class="wbadge">WATCHLIST</span>' : ''
    }</td>
    <td class="cat">${esc(r.category ?? 'Uncategorised')}</td>
    <td class="chains">${chains}</td>
    <td class="n">${fmtUSD(r.tvl_usd)}</td>
    <td class="n">${fmtChange(r.change_7d)}</td>
    <td class="n">${fmtAge(r.age_days)}</td>
    <td class="n">${fmtMult(r.model.peer_multiple)}</td>
    <td class="n"><strong>${fmtUSD(r.implied_value_usd)}</strong></td>
    <td><span class="score"><span class="bar"><span class="fill" style="width:${r.launch_score}%"></span></span><span class="sv">${r.launch_score}</span></span></td>
    <td class="flags">${flags}</td>
  </tr>`;
}

function renderBoard() {
  const out = visibleRows();
  $('rows').innerHTML = out.map(rowHTML).join('');
  $('count').innerHTML =
    `Showing <strong>${out.length}</strong> of ${rows.length} ranked protocols` +
    (state.watch ? ' · watchlist only' : '') +
    (state.cat ? ` · category: ${esc(state.cat)}` : '') +
    (state.chain ? ` · chain: ${esc(state.chain)}` : '') +
    (state.q ? ` · matching “${esc(state.q)}”` : '');
  document.querySelectorAll('#board thead th[data-sort]').forEach((th) => {
    const on = th.dataset.sort === state.sort;
    th.innerHTML = th.textContent.replace(/ [▲▼]$/, '') + (on ? ` <span class="dir">${state.dir === 1 ? '▲' : '▼'}</span>` : '');
  });
}

function syncControls() {
  $('q').value = state.q;
  catSel.value = state.cat;
  chainSel.value = state.chain;
  $('watch').checked = state.watch;
  $('hideRisk').checked = state.hideRisk;
}

function pushHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.cat) p.set('cat', state.cat);
  if (state.chain) p.set('chain', state.chain);
  if (state.watch) p.set('watch', '1');
  if (state.hideRisk) p.set('risk', '1');
  if (state.sort !== 'rank') p.set('sort', state.sort);
  if (state.dir !== 1) p.set('dir', String(state.dir));
  const qs = p.toString();
  history.replaceState(null, '', qs ? `#/?${qs}` : '#/');
}

function readControls() {
  state.q = $('q').value;
  state.cat = catSel.value;
  state.chain = chainSel.value;
  state.watch = $('watch').checked;
  state.hideRisk = $('hideRisk').checked;
  pushHash();
  renderBoard();
}
for (const id of ['q', 'cat', 'chain', 'watch', 'hideRisk']) $(id).addEventListener('input', readControls);
$('reset').addEventListener('click', () => {
  Object.assign(state, { q: '', cat: '', chain: '', watch: false, hideRisk: false, sort: 'rank', dir: 1 });
  syncControls();
  pushHash();
  renderBoard();
});
document.querySelectorAll('#board thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sort === k) state.dir = state.dir === 1 ? -1 : 1;
    else {
      state.sort = k;
      state.dir = k === 'rank' || k === 'name' ? 1 : -1;
    }
    pushHash();
    renderBoard();
  });
});
$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.row');
  if (tr && !e.target.closest('a')) location.hash = `#/p/${tr.dataset.slug}`;
});

// ------------------------------------------------------------------ the live set

$('liveRows').innerHTML = D.live
  .map(
    (p) => `<tr>
      <td class="name"><span class="nm">${esc(p.name)}</span><span class="slug">${esc(p.symbol ?? p.slug)}</span></td>
      <td class="cat">${esc(p.category ?? 'Uncategorised')}</td>
      <td class="n">${fmtUSD(p.tvl_usd)}</td>
      <td class="n"><strong>${fmtUSD(p.mcap_usd)}</strong></td>
      <td class="n">${fmtMult(p.value_per_tvl)}</td>
      <td class="n">${fmtChange(p.change_7d)}</td>
    </tr>`,
  )
  .join('');

// ------------------------------------------------------------------ detail view

/** Where a row's peer multiple came from, in one honest sentence. */
function peerSentence(r) {
  const m = r.model;
  const cat = r.category ?? 'uncategorised';
  if (m.peer_scope === 'category')
    return `the median of ${m.peer_count} live ${cat} protocols (${fmtMult(m.peer_median)}), weighted ${m.peer_count}/(${m.peer_count}+4) against the all-market median`;
  if (m.peer_scope === 'blended')
    return `a thin peer set, stated plainly: the median of ${m.peer_count} live ${cat} protocol${m.peer_count === 1 ? '' : 's'} (${fmtMult(m.peer_median)}), pulled toward the all-market median ${fmtMult(D.global_multiple)} with weight ${m.peer_count}/(${m.peer_count}+4)`;
  return `the all-market median across ${m.peer_count} live protocols: no live ${cat} protocol in the snapshot carries a market cap`;
}

function renderDetail(r) {
  const m = r.model;
  const product = Math.round(r.tvl_usd * m.peer_multiple * m.momentum_multiplier * m.maturity_multiplier * m.breadth_multiplier);
  const flags = r.risk_flags.length
    ? `<ul class="flaglist">${r.risk_flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '<p class="clean">No flags on this record: reported growth, a reported listing date, more than one chain, and no product risk.</p>';
  $('detailView').innerHTML = `
    <a class="back" href="#/">&larr; Back to the board</a>
    <div class="dhead">
      <div>
        <h2>${esc(r.name)}${r.on_watchlist ? '<span class="wbadge">WATCHLIST</span>' : ''}</h2>
        <p class="sub"><span class="slug">${esc(r.slug)}</span> · ${esc(r.category ?? 'Uncategorised')} · rank #${r.rank} of ${rows.length} · records no token</p>
      </div>
      <div class="bigval"><div class="v">${fmtFull(r.implied_value_usd)}</div><div class="k">implied value, model peer-1</div></div>
    </div>
    <div class="dgrid">
      <div class="dcard"><div class="v">${fmtFull(r.tvl_usd)}</div><div class="k">TVL in the snapshot</div></div>
      <div class="dcard"><div class="v">${r.change_7d === null ? 'not reported' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</div><div class="k">TVL change, 7 days</div></div>
      <div class="dcard"><div class="v">${r.age_days === null ? 'not reported' : `${r.age_days.toLocaleString('en-US')} days`}</div><div class="k">tracked with no token${r.listed_at ? ` (since ${esc(r.listed_at)})` : ''}</div></div>
      <div class="dcard"><div class="v">${r.launch_score} / 100</div><div class="k">launch score (readiness gauge)</div><div class="meter"><div class="fill" style="width:${r.launch_score}%"></div></div></div>
    </div>
    <div class="panel">
      <h3>Why this value</h3>
      <table class="math">
        <tr><td>TVL</td><td class="n">${fmtFull(r.tvl_usd)}</td><td>the snapshot's figure</td></tr>
        <tr><td>&times; peer multiple</td><td class="n">${fmtMult(m.peer_multiple)}</td><td>${esc(peerSentence(r))}</td></tr>
        <tr><td>&times; momentum</td><td class="n">${fmtFactor(m.momentum_multiplier)}</td><td>7-day change ${r.change_7d === null ? 'not reported, scored neutral' : `of ${r.change_7d.toFixed(1)}%, clamped to [-50%, +100%]`}</td></tr>
        <tr><td>&times; track record</td><td class="n">${fmtFactor(m.maturity_multiplier)}</td><td>${r.age_days === null ? 'listing date not reported, scored as 150 days' : `${r.age_days} days with no token`}</td></tr>
        <tr><td>&times; breadth</td><td class="n">${fmtFactor(m.breadth_multiplier)}</td><td>${r.chains.length} chain${r.chains.length === 1 ? '' : 's'} counted for TVL</td></tr>
        <tr class="total"><td>implied value</td><td class="n">${fmtFull(product)}</td><td>before the board's one-dollar floor</td></tr>
      </table>
      <p class="why">Priced like its peers: if ${esc(r.name)} issued a token today and the market valued it at the
      ${esc(r.category ?? 'category')} median per dollar of TVL, adjusted for its own week, its track record and its
      reach, the token would carry about ${fmtUSD(r.implied_value_usd)}. That is a statement about the record in the
      snapshot, not a forecast that a launch will happen.</p>
    </div>
    <div class="panel">
      <h3>Chains</h3>
      <div class="chips">${r.chains.length ? r.chains.map((c) => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="chip">none named</span>'}</div>
    </div>
    <div class="panel">
      <h3>Risk flags</h3>
      ${flags}
    </div>
    <div class="panel">
      <h3>Farm plan</h3>
      <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>`;
}

// ------------------------------------------------------------------ routing

function show(view) {
  $('boardView').hidden = view !== 'board';
  $('liveView').hidden = view !== 'live';
  $('detailView').hidden = view !== 'detail';
  $('tabBoard').classList.toggle('on', view !== 'live');
  $('tabLive').classList.toggle('on', view === 'live');
}

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/p/')) {
    const r = bySlug.get(decodeURIComponent(hash.slice(4)));
    if (r) {
      renderDetail(r);
      show('detail');
      window.scrollTo(0, 0);
      return;
    }
  }
  if (hash.startsWith('#/live')) {
    show('live');
    return;
  }
  const qs = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
  state.q = qs.get('q') ?? '';
  state.cat = qs.get('cat') ?? '';
  state.chain = qs.get('chain') ?? '';
  state.watch = qs.get('watch') === '1';
  state.hideRisk = qs.get('risk') === '1';
  state.sort = qs.get('sort') ?? 'rank';
  state.dir = qs.get('dir') === '-1' ? -1 : 1;
  syncControls();
  show('board');
  renderBoard();
}

$('tabBoard').addEventListener('click', () => (location.hash = '#/'));
$('tabLive').addEventListener('click', () => (location.hash = '#/live'));
window.addEventListener('hashchange', route);
route();
