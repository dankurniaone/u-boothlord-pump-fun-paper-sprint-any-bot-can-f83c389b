// Low Tide — Pump.fun Paper Sprint entry (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
//
// What it does, in one paragraph: it buys new pump.fun coins EARLY (a few slots after
// creation) but only while they are still near their create price and only once they
// have attracted at least 1 SOL of real money — the "low tide" coins, bought at the
// floor before the crowd arrives. It never chases a spike and never pyramids. Each
// position is exited on the first of: partial take-profit, full take-profit, stop
// loss, max hold, or the creator selling while held. One round trip per coin.
//
// Why this shape (measured on the kit's frozen dev window, 128,058 events, 1,222
// coins — the full dataset, not the 50k-line part-0 slice the kit tools read by
// default):
//   - Price NEVER falls below a coin's create price (min multiple 1.000 across all
//     1,222 coins), so buying near the floor caps the downside at the retracement.
//   - The spike happens in the first ~10 slots or never: coins not spiked by age 10
//     reach 1.5x later only 2.1% of the time, and 2x runners hit 2x at median slot 16.
//     Buying AFTER the spike (the house sniper pilot) eats the retracement: it nets
//     -0.50 SOL over the window. The house momentum pilot nets -9.41 SOL (wide stops,
//     2 SOL stakes) and reversion -3.82 SOL.
//   - The floor rule is the least-bad corner of ~150 backtested configurations on the
//     sibling sprint's identical dev dataset (same dataset_sha256): the Floor Sniper
//     graded net -0.054 SOL, 146 round trips, win rate 14.4%, max drawdown 0.6%,
//     0 rejections, two executions byte-identical. This bot starts from that corner
//     and re-sweeps it on this kit (another ~40 configs on the full dataset): the
//     shipped change is a wider stop (sl 1200 -> 2000 bps) and a higher take-profit
//     (tp 4000 -> 5000 bps), worth +0.0056 SOL in the local sim; the official
//     grade-local lands at -0.054 SOL, level with the sibling Floor Sniper's -0.054
//     — the difference sits inside the sim-vs-harness gap, so no edge is claimed
//     beyond holding the same least-losing corner at identical coin coverage.
//   - Three further edges were built, swept, and REJECTED on the evidence: partial
//     take-profit (bank half at +25%) costs -0.0045 SOL (it forfeits the runners and
//     pays an extra tx fee per partial); a flow-confirmation entry filter costs
//     -0.0097 SOL and 12 coins; exit-on-dev-sell costs -0.0017 SOL. They stay in the
//     code as off-by-default knobs with their measured costs recorded, not shipped.
//   - Tighter entry ceilings look better on net PnL but FAIL the guardrail: maxMult
//     1.15 nets -0.029 SOL over the window yet trades only 13 coins in the quietest
//     6h slice, below the 20-coin bar. The shipped maxMult 1.18 trades 23/34/51/39
//     coins across the four 6h slices — every slice clears the bar with margin.
//
// Determinism: the bot is a pure function of (state, batch). No clock, no environment,
// no Math.random, no seed use. Two executions produce byte-identical action logs.
// Node 22, stdlib only (erasable TypeScript, no build step): run by the grader as
// `node /bot/main.ts` with this directory mounted at /bot.

import { LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const LAM = LAMPORTS_PER_SOL;
const BPS = 10_000n;

export interface Params {
  minAge: number;
  maxAge: number;
  minMult: number;
  maxMult: number;
  minRealSol: number;
  maxDevBuySol: number;
  skipDevSold: boolean;
  stakeLamports: number;
  minBuyLamports: number;
  tpBps: number;
  slBps: number;
  maxHold: number;
  /** Partial take-profit: sell tp1PartBps of the position at +tp1Bps (0 = off). */
  tp1Bps: number;
  tp1PartBps: number;
  /** Entry needs recent net flow (buys minus sells, lamports) at least this over flowWindow slots. */
  flowWindow: number;
  minFlowLamports: number;
  /** Trailing stop: once up trailArmBps, exit on a fall of trailBps from the best value (0 = off). */
  trailArmBps: number;
  trailBps: number;
  /** Exit at once when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  slippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2,
  maxAge: 15,
  minMult: 1.0,
  maxMult: 1.18,
  minRealSol: 1.0,
  maxDevBuySol: 2.5,
  skipDevSold: true,
  stakeLamports: Number(LAM / 10n),
  minBuyLamports: Number(LAM / 100n),
  tpBps: 5000,
  slBps: 2000,
  maxHold: 20,
  tp1Bps: 0, // off: measured -0.0045 SOL on dev
  tp1PartBps: 5000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000_000, // off: measured -0.0097 SOL and -12 coins on dev
  trailArmBps: 0, // off: never triggers before tp/sl/max-hold on dev
  trailBps: 0,
  exitOnDevSell: false, // off: measured -0.0017 SOL on dev
  slippageBps: 10_000,
};

const PROTOCOL_FEE_BPS = 95n;
const CREATOR_FEE_BPS = 30n;
const PRUNE_AGE = 200;

interface Coin {
  mint: string;
  createSlot: number;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuySol: number;
  devSold: boolean;
  done: boolean;
  /** Recent trades: [slot, signed sol lamports] for the flow filter. */
  flow: Array<[number, bigint]>;
}

interface OpenPos {
  openSlot: number;
  basis: bigint;
  tp1Done: boolean;
  bestValue: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

/** Net SOL a sell of `tokens` returns at the curve's current reserves (the sim's quoteSell). */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - feeOf(q, PROTOCOL_FEE_BPS) - feeOf(q, CREATOR_FEE_BPS);
}

export function createStrategy(p: Params) {
  const coins = new Map<string, Coin>();
  const open = new Map<string, OpenPos>();

  function hasPendingBuy(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) {
      if (pend.order.side === 'buy' && pend.order.mint === mint) return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) {
      if (pend.order.side === 'sell' && pend.order.mint === mint) return true;
    }
    return false;
  }

  function recentFlow(c: Coin, now: number): bigint {
    let sum = 0n;
    for (const [slot, amt] of c.flow) if (now - slot <= p.flowWindow) sum += amt;
    return sum;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];

      // --- fills: record open slot / basis on buys, close out finished coins on sells ---
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy' && !f.client_id.startsWith('_')) {
          open.set(f.mint, {
            openSlot: f.slot,
            basis: BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports),
            tp1Done: false,
            bestValue: 0n,
          });
        } else if (f.status === 'filled' && f.side === 'sell') {
          const o = open.get(f.mint);
          const pos = state.positions.get(f.mint);
          if (o !== undefined && pos !== undefined && pos.token_amount > 0n) {
            // Partial sell: keep the position open with a proportionally scaled basis.
            const remaining = pos.token_amount;
            const sold = BigInt(f.token_amount);
            const total = remaining + sold;
            o.basis = total > 0n ? (o.basis * remaining) / total : 0n;
            o.tp1Done = true;
          } else {
            open.delete(f.mint);
            const c = coins.get(f.mint);
            if (c) c.done = true;
          }
        }
      }
      // Safety net: a position the account no longer reports (harness close: complete /
      // flatten / writeoff) with no sell pending is finished — mark it done.
      for (const mint of open.keys()) {
        if (!state.positions.has(mint) && !hasPendingSell(state, mint)) {
          open.delete(mint);
          const c = coins.get(mint);
          if (c) c.done = true;
        }
      }

      // --- events: register creates, watch the creator, track the flow tape ---
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!coins.has(e.mint)) {
            coins.set(e.mint, {
              mint: e.mint,
              createSlot: e.slot,
              creator: e.creator,
              vq0: BigInt(e.virtual_quote_reserves),
              vt0: BigInt(e.virtual_token_reserves),
              devBuySol: 0,
              devSold: false,
              done: false,
              flow: [],
            });
          }
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            if (e.user === c.creator) {
              if (e.is_buy) c.devBuySol += Number(e.sol_amount) / 1e9;
              else c.devSold = true;
            }
            const signed = e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount);
            c.flow.push([e.slot, signed]);
            if (c.flow.length > 64) c.flow.splice(0, c.flow.length - 64);
          }
        } else if (e.event === 'CompleteEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // --- exits: partial TP, full TP, stop-loss, trailing stop, dev-sell, max-hold ---
      for (const [mint, pos] of state.positions) {
        // A position with no open record (e.g. its buy fill was missed) still gets
        // managed: synthesize a basis from its reported cost so it is never abandoned
        // to the end-of-window flatten.
        const o = open.get(mint) ?? { openSlot: now, basis: pos.cost_lamports + tx, tp1Done: false, bestValue: 0n };
        if (!open.has(mint)) open.set(mint, o);
        if (hasPendingSell(state, mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue; // harness closes completed curves
        const value = sellProceeds(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
        if (value > o.bestValue) o.bestValue = value;
        const c = coins.get(mint);
        let exit = false;
        let partial = false;
        if (p.tp1Bps > 0 && !o.tp1Done && value * BPS >= o.basis * (BPS + BigInt(p.tp1Bps))) {
          partial = true;
        } else if (value * BPS >= o.basis * (BPS + BigInt(p.tpBps))) exit = true;
        else if (value * BPS <= o.basis * (BPS - BigInt(p.slBps))) exit = true;
        else if (p.trailArmBps > 0 && o.bestValue * BPS >= o.basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= o.bestValue * (BPS - BigInt(p.trailBps))) exit = true;
        else if (p.exitOnDevSell && c !== undefined && c.devSold) exit = true;
        else if (now - o.openSlot >= p.maxHold) exit = true;
        if (partial || exit) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) continue;
          if (exit && c !== undefined) c.done = true; // one round trip per coin, even if this sell fails
          const amount = partial ? (pos.token_amount * BigInt(p.tp1PartBps)) / BPS : pos.token_amount;
          if (amount <= 0n) continue;
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.slippageBps });
        }
      }

      // --- entries: floor coins only, one buy per coin, guardrail-sized ---
      let free = state.freeCashLamports();
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const age = now - c.createSlot;
        if (age > PRUNE_AGE && !state.positions.has(c.mint) && !open.has(c.mint)) {
          coins.delete(c.mint);
          continue;
        }
        if (age < p.minAge || age > p.maxAge) continue;
        if (c.done) continue;
        if (state.positions.has(c.mint) || open.has(c.mint)) continue;
        if (hasPendingBuy(state, c.mint)) continue;
        if (slots <= 0) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined) continue;
        if (curve.complete) {
          c.done = true;
          continue;
        }
        if (Number(curve.real_quote_reserves) / 1e9 < p.minRealSol) continue;
        if (c.devBuySol > p.maxDevBuySol) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (recentFlow(c, now) < BigInt(p.minFlowLamports)) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const p0 = Number(c.vq0) / Number(c.vt0);
        const mult = price / p0;
        if (mult < p.minMult || mult > p.maxMult) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const stake = BigInt(p.stakeLamports);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < BigInt(p.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.slippageBps });
        free -= amount + tx;
        slots -= 1;
      }
      return orders;
    },
  };
}
