// Launchscope's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks protocols that record no token yet by the value a token would carry if it
// traded the way their live peers do. Nothing is priced from a list of names: every figure
// below is computed from the snapshot's own ten fields, and the same code scores every row.
//
//   peer multiple   each live peer's market-cap / TVL ratio is first winsorised to
//                   [RATIO_MIN, RATIO_MAX], so a peer with a near-zero TVL denominator
//                   cannot price a category; the category's median ratio is then weighted
//                   n / (n + PEER_SHRINK_SPAN) against the all-market median, so a category
//                   needs a deep peer set before its own median prices the board, and the
//                   result is clamped to [MULTIPLE_MIN, MULTIPLE_MAX]
//   momentum        1 + MOMENTUM_WEIGHT x clamp(change_7d, FLOOR, CAP) / 100: a growing
//                   protocol's token would open into demand; an unreported change is neutral
//   track record    MATURITY_BASE + MATURITY_SPAN x age / (age + MATURITY_HALF_DAYS): the
//                   longer a protocol has run with no token, the more of its record a buyer
//                   can see; an unreported listing date is scored as UNKNOWN_AGE_DAYS
//   breadth         1 + BREADTH_PER_CHAIN x min(chains - 1, BREADTH_MAX_EXTRA): a token
//                   distributed across more chains reaches more holders
//   implied value   round(TVL x peer multiple x momentum x track record x breadth), at
//                   least one dollar; the factors are rounded to 4 places first, so the
//                   arithmetic a reader sees on the dashboard is the arithmetic that priced
//                   the row, to the dollar
//
// A separate launch score (0 to 100) blends size, track record, momentum and breadth into a
// readiness gauge for the dashboard's sorting; it never moves a rank, which is the implied
// value's alone.
//
// Who is ranked: every watchlist slug (the floor, never a ceiling), plus every other protocol
// that records no token and passes the same product test the watchlist's own definition
// applies: not an exchange, not a bridge-balance category (DefiLlama's bridge entries are
// mostly balances of assets that already trade), not a versioned pool of another protocol,
// and not a wrapped, staked or staking product of one, by name. Protocols whose token already
// trades are never ranked; they are the peer set that prices the board, and the dashboard
// shows them apart, at the market's own values.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, stated on the dashboard. */
export const MODEL_VERSION = 'peer-1';

export const MOMENTUM_WEIGHT = 0.35;
export const MOMENTUM_FLOOR = -50;
export const MOMENTUM_CAP = 100;
export const MATURITY_BASE = 0.78;
export const MATURITY_SPAN = 0.34;
export const MATURITY_HALF_DAYS = 365;
export const UNKNOWN_AGE_DAYS = 150;
export const BREADTH_PER_CHAIN = 0.015;
export const BREADTH_MAX_EXTRA = 12;
export const PEER_SHRINK_SPAN = 4;
export const RATIO_MIN = 0.01;
export const RATIO_MAX = 5;
export const MULTIPLE_MIN = 0.02;
export const MULTIPLE_MAX = 3;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /(^|\s)(wrapped|staked|staking)(\s|$)/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const BALANCE_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge']);

/**
 * Whether a protocol could still issue a token of its own: it records none, and it is not an
 * exchange, a bridge-balance entry, a versioned pool, or a wrapped or staked product of a
 * token that already trades. The watchlist's own tests, applied at every size.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BALANCE_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** What one category's live peers say a token is worth per dollar of TVL. */
export interface PeerMultiple {
  /** The multiple rows in this category are priced with, after shrinkage and clamping. */
  multiple: number;
  /** How many live peers carry a market cap in this category (the all-market count for 'global'). */
  peers: number;
  /** The category's own winsorised median ratio, before shrinkage; null when it has no peers. */
  category_median: number | null;
  scope: 'category' | 'blended' | 'global';
}

/** The peer multiples for every category, plus the all-market fallback under key ''. */
export function peerMultiples(snapshot: Snapshot): Map<string, PeerMultiple> {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const raw = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ratio = clamp(raw, RATIO_MIN, RATIO_MAX);
    all.push(ratio);
    const key = p.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const out = new Map<string, PeerMultiple>();
  out.set('', { multiple: round4(clamp(globalMedian, MULTIPLE_MIN, MULTIPLE_MAX)), peers: all.length, category_median: null, scope: 'global' });
  for (const [key, ratios] of ratiosByCategory) {
    const catMedian = median(ratios);
    const weight = ratios.length / (ratios.length + PEER_SHRINK_SPAN);
    const shrunk = weight * catMedian + (1 - weight) * globalMedian;
    out.set(key, {
      multiple: round4(clamp(shrunk, MULTIPLE_MIN, MULTIPLE_MAX)),
      peers: ratios.length,
      category_median: round4(catMedian),
      scope: ratios.length >= 6 ? 'category' : 'blended',
    });
  }
  return out;
}

/** The factors one protocol is priced with, and the implied value they produce. */
export interface Pricing {
  peer: PeerMultiple;
  momentum: number;
  maturity: number;
  breadth: number;
  age: number | null;
  implied: number;
}

/** Price one pre-token protocol from the snapshot's own figures. */
export function price(p: SnapshotProtocol, asOf: string, multiples: Map<string, PeerMultiple>): Pricing {
  const peer = multiples.get(p.category ?? '') ?? multiples.get('')!;
  const age = ageDays(asOf, p.listed_at);
  const growth = p.change_7d === null ? 0 : clamp(p.change_7d, MOMENTUM_FLOOR, MOMENTUM_CAP);
  const momentum = round4(1 + (growth / 100) * MOMENTUM_WEIGHT);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturity = round4(MATURITY_BASE + MATURITY_SPAN * (ageForModel / (ageForModel + MATURITY_HALF_DAYS)));
  const breadth = round4(1 + BREADTH_PER_CHAIN * Math.min(Math.max(p.chains.length - 1, 0), BREADTH_MAX_EXTRA));
  const implied = Math.max(1, Math.round(p.tvl_usd * peer.multiple * momentum * maturity * breadth));
  return { peer, momentum, maturity, breadth, age, implied };
}

/** A readiness gauge from 0 to 100: size, track record, momentum and breadth. Display only. */
export function launchScore(p: SnapshotProtocol, age: number | null): number {
  const size = clamp(Math.log10(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log10(600), 0, 1);
  const track = age === null ? 0.3 : age / (age + MATURITY_HALF_DAYS);
  const momentum = p.change_7d === null ? 0.5 : (clamp(p.change_7d, MOMENTUM_FLOOR, MOMENTUM_CAP) - MOMENTUM_FLOOR) / (MOMENTUM_CAP - MOMENTUM_FLOOR);
  const breadth = Math.min(p.chains.length, BREADTH_MAX_EXTRA) / BREADTH_MAX_EXTRA;
  return Math.round(100 * (0.45 * size + 0.2 * track + 0.2 * momentum + 0.15 * breadth));
}

const PRODUCT_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Restaked BTC', 'Stablecoin Wrapper', 'Anchor BTC', 'Decentralized BTC']);

/** The honest warnings on one row, derived from its own record. */
export function riskFlags(p: SnapshotProtocol, age: number | null): string[] {
  const flags: string[] = [];
  if (p.change_7d === null) flags.push('7-day change not reported');
  else if (p.change_7d <= -20) flags.push(`shrinking: TVL down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days`);
  else if (p.change_7d >= 100) flags.push(`parabolic week: TVL up ${p.change_7d.toFixed(0)}% in 7 days may not hold`);
  if (p.listed_at === null) flags.push('listing date not reported');
  else if (age !== null && age < 90) flags.push(`young: tracked for only ${age} days`);
  if (p.chains.length <= 1) flags.push('single-chain');
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) flags.push('product risk: its TVL is a claim on assets that already trade');
  if (p.tvl_usd < 10_000_000) flags.push('small base: under $10M of TVL');
  return flags;
}

// ------------------------------------------------------------------ farm plans

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 200;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 10_000_000) return 100;
  return 50;
}

/** The gas a qualifying action costs on a chain, in words a farmer can budget with. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $12 of gas';
  if (chain === 'Solana') return 'under $1 of fees';
  if (chain === 'BNB Chain') return 'about $1 of gas';
  return 'about $2 of gas';
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type Playbook = 'lending' | 'dex' | 'yield' | 'staking' | 'derivatives' | 'prediction' | 'rwa' | 'insurance' | 'chain' | 'generic';

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('dex') || c.includes('liquidity')) return 'dex';
  if (c.includes('staking') || c.includes('restak') || c.includes('anchor') || c.includes('decentralized btc')) return 'staking';
  if (c.includes('derivative') || c.includes('perpetual')) return 'derivatives';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('insurance')) return 'insurance';
  if (c === 'chain') return 'chain';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis') || c.includes('farm') || c.includes('index')) return 'yield';
  return 'generic';
}

/** The playbook's core position and second leg, in the words a farmer can follow. */
function actionsFor(kind: Playbook, name: string, chain: string, secondChain: string | null, capital: number): [string, string] {
  switch (kind) {
    case 'lending':
      return [
        `Supply $${capital} of USDC to ${name} on ${chain} and leave the deposit open; supplied balances are the activity lending protocols count.`,
        secondChain !== null
          ? `Open a second, smaller supply position on ${secondChain} so the farm is not riding on one chain's snapshot.`
          : `Borrow no more than 25% against the deposit once, then repay it a week later, so both sides of the market see the wallet.`,
      ];
    case 'dex':
      return [
        `Provide $${capital} split evenly across the pair in ${name}'s deepest pool on ${chain} and keep the LP position open.`,
        `Route your weekly swaps through ${name} itself rather than an aggregator, so the volume is credited to your wallet there.`,
      ];
    case 'staking':
      return [
        `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the staking receipt in the same wallet.`,
        `Restake or re-deposit half the receipt only if ${name} offers it natively; never bridge the receipt to an unrelated app.`,
      ];
    case 'derivatives':
      return [
        `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, long and short the same asset in equal size.`,
        `Roll the hedge once a week instead of chasing direction: steady margin and volume are what a derivatives launch rewards.`,
      ];
    case 'prediction':
      return [
        `Fund $${capital} on ${name} and take positions in three different markets, sized so no single outcome can halve the stake.`,
        `Trade a little in a new market each week rather than one large bet: breadth of markets is the activity that gets counted.`,
      ];
    case 'rwa':
      return [
        `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it untouched; time in the asset is the signal these issuers read.`,
        `Complete every onboarding and attestation step ${name} asks for early, since late paperwork is the usual reason a holder is skipped.`,
      ];
    case 'insurance':
      return [
        `Buy $${capital} of cover from ${name} on ${chain} for a position you actually hold, and keep the policy to expiry.`,
        `Underwrite a small amount into one cover pool as well, so the wallet appears on both sides of the protocol.`,
      ];
    case 'chain':
      return [
        `Bridge $${capital} of USDC to ${chain} and hold it there; a young chain counts resident balances before anything else.`,
        `Use two native apps on ${chain} in the first week, a swap and a lend, so the wallet reads as a resident, not a passer-by.`,
      ];
    case 'yield':
      return [
        `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the wallet that deposited them.`,
        secondChain !== null
          ? `Split a second deposit of half that size into the same vault family on ${secondChain} to widen the footprint.`
          : `Compound the yield back into the same vault once a month rather than withdrawing it, so the balance only grows.`,
      ];
    default:
      return [
        `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open.`,
        `Use one more of ${name}'s own features in the second week, a second pool, a vote or a referral-free second deposit.`,
      ];
  }
}

/** A step held to the gate's 20 to 600 characters, whatever the template produced. */
function stepText(s: string): string {
  let out = s.trim();
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Hold the position and re-check the protocol's own page weekly.`;
  return out;
}

/**
 * A protocol's farm plan: six steps, each an action with what it costs and how long it takes,
 * derived from the protocol's own record (category, chains, TVL, age), never from its name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const [core, second] = actionsFor(playbookFor(p.category), p.name, chain, secondChain, capital);
  return [
    `Set up a fresh wallet for ${p.name} and fund it on ${chain}; keep its seed phrase offline and never farm from a wallet that holds unrelated assets. Cost: under $5 to fund. Time: 10 minutes.`,
    `${core} Cost: $${capital} of capital plus ${gasFor(chain)}. Time: 15 minutes to set up.`,
    `${second} Cost: about $${Math.max(10, Math.round(capital / 5))} more capital plus ${gasFor(secondChain ?? chain)}. Time: 10 minutes.`,
    `Make one qualifying action every week, a deposit top-up, a swap, a vote or a claim of accrued yield, so no weekly snapshot misses the wallet. Cost: ${gasFor(chain)} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without withdrawing below the opening balance, so the activity spans more than one rewards snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Check ${p.name}'s own points or rewards page before withdrawing, claim only from the link the protocol itself publishes, and log every transaction with its date for the unwind. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
  ].map(stepText);
}

// ------------------------------------------------------------------ the board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  launch_score: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    peer_scope: 'category' | 'blended' | 'global';
    peer_median: number | null;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  risk_flags: string[];
  farm_steps: string[];
}

/** The board: every watchlist slug plus every launch candidate, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = peerMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watchlist.has(p.slug) || isLaunchCandidate(p));
  const priced = chosen.map((p) => {
    const pricing = price(p, snapshot.as_of, multiples);
    return { p, pricing };
  });
  priced.sort(
    (a, b) =>
      b.pricing.implied - a.pricing.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return priced.map(({ p, pricing }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: pricing.age,
    on_watchlist: watchlist.has(p.slug),
    token_status: 'pre-token',
    implied_value_usd: pricing.implied,
    launch_score: launchScore(p, pricing.age),
    model: {
      peer_multiple: pricing.peer.multiple,
      peer_count: pricing.peer.peers,
      peer_scope: pricing.peer.scope,
      peer_median: pricing.peer.category_median,
      momentum_multiplier: pricing.momentum,
      maturity_multiplier: pricing.maturity,
      breadth_multiplier: pricing.breadth,
    },
    risk_flags: riskFlags(p, pricing.age),
    farm_steps: farmSteps(p, pricing.age),
  }));
}

/** A live-token protocol: it already trades, so it is shown at the market's own value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  symbol: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  value_per_tvl: number;
  change_7d: number | null;
}

/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The live set: the peer protocols that price the board, shown apart from it. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      symbol: p.symbol,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      value_per_tvl: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : 0,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders: the board, the live set, and the model stated in numbers. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  scanned: number;
  pre_token: number;
  candidates: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  global_peers: number;
  rows: BoardRow[];
  live: LiveRow[];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; data: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const multiples = peerMultiples(snapshot);
  const global = multiples.get('')!;
  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    scanned: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter(isPreToken).length,
    candidates: snapshot.protocols.filter(isLaunchCandidate).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    global_multiple: global.multiple,
    global_peers: global.peers,
    rows: board,
    live,
  };
  return { board, data };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's seven rows that read the board. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the page reads it where it lies. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
