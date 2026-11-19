[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/konzlodon74-dot/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/konzlodon74-dot/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Launchscope — a token launch radar

An entry for make.fun's [token-radar-01](https://make.fun/bounty/token-radar-01) bounty.

Launchscope reads the sealed DefiLlama snapshot at `/input/snapshot.json` and ranks the
protocols that record no token yet by an **implied value**: what a token would be worth if it
traded the way the protocol's live peers do.

## The model (peer-1)

One formula prices every row, from the snapshot's own figures only — no protocol is priced
by name:

```
implied value = TVL x peer multiple x momentum x track record x breadth
```

- **Peer multiple** — each live peer's market-cap / TVL ratio winsorised to [0.01, 5]; the
  category's median is weighted n / (n + 4) against the all-market median, so a thin peer set
  cannot price the board, and the result is clamped to [0.02, 3]. Every row shows its peer
  count and its category's raw median.
- **Momentum** — 1 + 0.35 x the 7-day TVL change, clamped to [-50%, +100%]. An unreported
  change is neutral and flagged.
- **Track record** — 0.78 + 0.34 x age / (age + 365 days), from the day DefiLlama began
  tracking the protocol. An unreported listing date scores as 150 days and is flagged.
- **Breadth** — 1 + 0.015 per extra chain, up to twelve.

The factors are rounded before they are multiplied, so the breakdown on each protocol's
dashboard page reproduces its board value to the dollar. A separate **launch score** (0–100)
blends size, track record, momentum and breadth as a readiness gauge; it never moves a rank.

The board covers every slug on the snapshot's watchlist, then applies the watchlist's own
product test at every size: a candidate must record no token, and must not be an exchange, a
bridge-balance entry, a versioned pool of another protocol, or a wrapped, staked or staking
product of one. Protocols whose token already trades are never ranked; they are the peer set
that prices the board, and the dashboard shows them apart at the market's own values.

Each row carries a six-step farm plan derived from the protocol's category, chains, TVL and
age — the action, what it costs and how long it takes — plus honest risk flags read from its
own record.

## Run it

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only. The run writes `board.json`, `data.js`,
`dashboard/`, `screenshots/` and `dossier.json` to the output directory, and is
deterministic: the same snapshot in, the same bytes out.

## Layout

- `main.ts` — the program: snapshot in, board and dashboard out, dossier last.
- `lib/model.ts` — the peer-anchored model, the board, the farm plans and the gate self-check.
- `dashboard/` — the static page (no network): the board, a detail page per protocol, the
  live peer set, filters and sorting.
- `screenshots/` — the board, a detail view and a filtered view, captured from the page.
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte as the kit ships it.

## License

MIT — see `LICENSE`.
