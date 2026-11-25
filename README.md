# Low Tide — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dankurniaone/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/dankurniaone/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. Node 22, stdlib only — run by the grader as `node /bot/main.ts`.

## Strategy

**Buy the floor at low tide, never chase the spike.** New pump.fun coins are bought 2–15 slots after creation, but only while they are still near their create price (0–18% above it) and only once they have attracted at least 1 SOL of real money. Each position exits on the first of: **+50%** net value, **−20%** net value, or **20 slots held**. One round trip per coin, no pyramiding.

Why this shape — measured on the kit's frozen 24h dev window (1,222 coins, full 128,058-event dataset, not the 50k-line part-0 slice):

- A coin's price **never falls below its create price** (minimum multiple 1.000 across all 1,222 coins), so buying near the floor caps the downside at the retracement.
- The spike happens in the first ~10 slots or never: coins not spiked by age 10 reach 1.5x later only 2.1% of the time, and 2x runners hit 2x at median slot 16. Buying after the spike eats the retracement — the house sniper pilot nets −0.50 SOL, momentum −9.41 SOL, reversion −3.82 SOL on the same window.
- **Backtest (official `grade-local`, process driver): net −0.054 SOL, 147 round trips, win rate 15.6%, max drawdown 0.64%, 0 rejections, guardrails met (147 coins hold a round trip ≥ 0.01 SOL). L1 regrade reproduced byte for byte.** The local replay sim measured −0.049 SOL on the same window; the ~0.006 SOL gap is the sim-vs-harness difference, so no edge is claimed beyond holding the least-losing corner. On the four 6h slices (the final window is 6h, sim-measured) it trades 23 / 34 / 51 / 39 coins — every slice clears the 20-coin guardrail — with one slice net positive (+0.0075 SOL). Drawdown stays under 0.7% everywhere, far inside the 50% guardrail.
- Every round trip buys **≥ 0.01 SOL** (guardrail-sized): the 1% size cap means a 0.01 SOL buy needs ≥ 1 SOL of real reserves, which is why the entry requires real SOL ≥ 1.0.
- Rug filter: skip the coin if the creator sold any, or bought more than 2.5 SOL.
- Three further edges were built, swept, and rejected on the evidence (partial take-profit −0.0045 SOL, flow-confirmation entry filter −0.0097 SOL and −12 coins, exit-on-dev-sell −0.0017 SOL). They stay in `strategy.ts` as off-by-default knobs. Tighter entry ceilings (maxMult 1.15) look better on net PnL (−0.029 SOL) but trade only 13 coins in the quietest 6h slice — below the 20-coin bar — so they were not shipped.

## Files

- `main.ts` — entrypoint: wires the strategy into the harness.
- `strategy.ts` — the whole strategy (parameterized, deterministic).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`.

## Determinism

The bot is a pure function of `(state, batch)`: no clock, no environment, no `Math.random`, no seed use. Two executions produce byte-identical action logs.
