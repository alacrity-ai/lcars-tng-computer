import type { FastifyInstance } from "fastify";
import type { QuotePanelProps, QuotePoint, QuoteRange } from "@tng/shared";
import type { DisplayHub } from "../hub.js";
import { cancelActiveReading } from "../reading.js";

/**
 * Keyless quotes, two providers:
 * - Crypto: CoinGecko (reliable, generous, intraday granularity).
 * - Stocks/ETFs/indices/forex: Yahoo Finance v8 chart — unofficial, so the
 *   client is defensive: session-cookie warm-up, query1/query2 rotation,
 *   and a 60s response cache so a chatty session can't trigger 429 cooldowns.
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const RANGES: Record<QuoteRange, { range: string; interval: string; days: number }> = {
  daily: { range: "1d", interval: "5m", days: 1 },
  weekly: { range: "5d", interval: "30m", days: 7 },
  monthly: { range: "1mo", interval: "1d", days: 30 },
  yearly: { range: "1y", interval: "1wk", days: 365 },
};

// ---------- tiny response cache (both providers) ----------

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; props: QuotePanelProps }>();

function cacheGet(key: string): QuotePanelProps | undefined {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return undefined;
  return hit.props;
}

// ---------- Yahoo ----------

interface YahooChart {
  meta: {
    symbol: string;
    currency?: string;
    exchangeName?: string;
    fullExchangeName?: string;
    shortName?: string;
    longName?: string;
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    regularMarketTime?: number;
  };
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
}

let yahooCookie: { value: string; at: number } | null = null;

/** Yahoo 429s bare clients; a fc.yahoo.com session cookie (cached ~4h) keeps
    us looking like a browser session. */
async function getYahooCookie(): Promise<string | undefined> {
  if (yahooCookie && Date.now() - yahooCookie.at < 4 * 3600_000) return yahooCookie.value;
  try {
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "user-agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const setCookie = res.headers.get("set-cookie");
    const match = setCookie?.match(/^[^;]+/);
    if (match) {
      yahooCookie = { value: match[0], at: Date.now() };
      return yahooCookie.value;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

async function fetchYahooChart(symbol: string, r: QuoteRange): Promise<YahooChart | null> {
  const { range, interval } = RANGES[r];
  const cookie = await getYahooCookie();
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
        {
          headers: {
            "user-agent": UA,
            accept: "application/json",
            ...(cookie ? { cookie } : {}),
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.status === 429) continue; // try the other host
      if (!res.ok) return null;
      const data = (await res.json()) as { chart?: { result?: YahooChart[] } };
      return data.chart?.result?.[0] ?? null;
    } catch {
      /* try next host */
    }
  }
  return null;
}

/** "apple" → AAPL via Yahoo search (same defensive headers). */
async function resolveYahooSymbol(query: string): Promise<string | null> {
  const cookie = await getYahooCookie();
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`,
      {
        headers: { "user-agent": UA, accept: "application/json", ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { quotes?: { symbol?: string; quoteType?: string }[] };
    const preferred = ["EQUITY", "CRYPTOCURRENCY", "ETF", "INDEX", "MUTUALFUND", "CURRENCY"];
    const quotes = (data.quotes ?? []).filter((q) => typeof q.symbol === "string");
    quotes.sort(
      (a, b) =>
        (preferred.indexOf(a.quoteType ?? "") + 99) - (preferred.indexOf(b.quoteType ?? "") + 99),
    );
    return quotes[0]?.symbol ?? null;
  } catch {
    return null;
  }
}

function yahooProps(chart: YahooChart, range: QuoteRange): QuotePanelProps | null {
  const meta = chart.meta;
  const stamps = chart.timestamp ?? [];
  const closes = chart.indicators?.quote?.[0]?.close ?? [];
  const points: QuotePoint[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const v = closes[i];
    if (typeof v === "number") points.push({ t: stamps[i] * 1000, v });
  }
  const price = meta.regularMarketPrice ?? points[points.length - 1]?.v;
  if (typeof price !== "number") return null;

  // Daily change is vs previous close (the number people mean); longer
  // ranges are vs the first point in the window.
  const basis =
    range === "daily"
      ? (meta.chartPreviousClose ?? meta.previousClose ?? points[0]?.v)
      : points[0]?.v;
  const change = typeof basis === "number" ? price - basis : 0;

  return {
    symbol: meta.symbol,
    name: meta.shortName ?? meta.longName ?? meta.symbol,
    price,
    currency: meta.currency,
    change,
    changePercent: typeof basis === "number" && basis !== 0 ? (change / basis) * 100 : 0,
    range,
    points,
    exchange: meta.fullExchangeName ?? meta.exchangeName,
    asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : undefined,
  };
}

// ---------- CoinGecko ----------

/** "BTC-USD" → "btc", "bitcoin" → "bitcoin" — the search token. */
function cryptoToken(symbol: string): string {
  return symbol.replace(/-(USD|EUR|USDT)$/i, "").toLowerCase();
}

function looksLikeCrypto(symbol: string): boolean {
  return /-(USD|USDT)$/i.test(symbol) || /^(btc|eth|bitcoin|ethereum|dogecoin|solana|xrp|cardano|litecoin|monero)$/i.test(symbol);
}

async function resolveCoin(token: string): Promise<{ id: string; name: string; symbol: string } | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(token)}`,
      { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      coins?: { id: string; name: string; symbol: string }[];
    };
    const coins = data.coins ?? [];
    // Exact ticker match beats popularity ordering ("btc" → Bitcoin).
    const exact = coins.find((c) => c.symbol.toLowerCase() === token);
    return exact ?? coins[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchCoinProps(symbol: string, range: QuoteRange): Promise<QuotePanelProps | null> {
  const coin = await resolveCoin(cryptoToken(symbol));
  if (!coin) return null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.id)}/market_chart?vs_currency=usd&days=${RANGES[range].days}`,
      { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { prices?: [number, number][] };
    const raw = (data.prices ?? []).filter(
      (p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number",
    );
    if (raw.length < 2) return null;
    // Thin dense series so the wall isn't pushing thousands of points around.
    const step = Math.max(1, Math.floor(raw.length / 200));
    const points: QuotePoint[] = raw
      .filter((_, i) => i % step === 0 || i === raw.length - 1)
      .map(([t, v]) => ({ t, v }));
    const price = points[points.length - 1].v;
    const basis = points[0].v;
    return {
      symbol: `${coin.symbol.toUpperCase()}-USD`,
      name: coin.name,
      price,
      currency: "USD",
      change: price - basis,
      changePercent: basis !== 0 ? ((price - basis) / basis) * 100 : 0,
      range,
      points,
      exchange: "CoinGecko",
      asOf: points[points.length - 1].t,
    };
  } catch {
    return null;
  }
}

// ---------- route ----------

export function registerQuoteRoutes(app: FastifyInstance, hub: DisplayHub) {
  app.post<{ Body: { symbol?: string; range?: QuoteRange } }>(
    "/api/console/show-quote",
    async (req, reply) => {
      const symbol = req.body?.symbol?.trim();
      const range: QuoteRange = req.body?.range ?? "daily";
      if (!symbol) return reply.code(400).send({ error: "symbol is required" });
      if (!RANGES[range]) {
        return reply.code(400).send({ error: "range must be daily|weekly|monthly|yearly" });
      }

      const cacheKey = `${symbol.toUpperCase()}:${range}`;
      let props = cacheGet(cacheKey);

      if (!props) {
        const crypto = looksLikeCrypto(symbol);
        if (crypto) {
          props = (await fetchCoinProps(symbol, range)) ?? undefined;
        }
        if (!props) {
          let chart = await fetchYahooChart(symbol, range);
          if (!chart) {
            const resolved = await resolveYahooSymbol(symbol);
            if (resolved && resolved.toUpperCase() !== symbol.toUpperCase()) {
              chart = await fetchYahooChart(resolved, range);
            }
          }
          if (chart) props = yahooProps(chart, range) ?? undefined;
        }
        // NO crypto fallback for stock-looking symbols: CoinGecko happily
        // matches "AAPL" to tokenized-stock coins, which is a wrong answer
        // wearing the right ticker. Better to fail honestly.
        if (props) cache.set(cacheKey, { at: Date.now(), props });
      }

      if (!props) {
        return reply.code(502).send({
          error: `no quote data for "${symbol}" — the stock data provider may be rate-limiting; try again in a few minutes`,
        });
      }

      cancelActiveReading();
      hub.broadcast(
        { type: "display", view: "quote", props: { ...props } },
        hub.resolveWall((req.body as { wall?: string } | undefined)?.wall),
      );
      return {
        ok: true,
        symbol: props.symbol,
        name: props.name,
        price: props.price,
        currency: props.currency,
        change: +props.change.toFixed(4),
        changePercent: +props.changePercent.toFixed(2),
        range,
      };
    },
  );
}
