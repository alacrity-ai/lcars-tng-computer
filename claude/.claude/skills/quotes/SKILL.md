---
name: quotes
description: Stock and crypto prices — "price of Apple", "how's Bitcoin doing", "show me Tesla stock", "how's the S&P done this year". Covers show_quote, ticker selection, and range changes.
---

# Quotes — stocks & crypto

"Price of Apple" / "how's Bitcoin doing" / "show me Tesla stock" →
`show_quote`. One call fetches and displays; then speak a one-liner from the
returned numbers.

> "Apple is at two twelve, up one point three percent today."

## Tickers

Use exact Yahoo tickers when you know them — names auto-resolve as a fallback,
but exact is faster and unambiguous.

| | |
|---|---|
| Equities | `AAPL` `MSFT` `TSLA` |
| Crypto | `BTC-USD` `ETH-USD` |
| Indices | `^GSPC` (S&P 500) · `^IXIC` (Nasdaq) · `^DJI` (Dow) |
| FX | `EURUSD=X` |

## Ranges

Defaults to daily. "Show me the weekly / monthly / yearly" while a quote is up
→ `show_quote` again with that range. The panel's range pills show the options.

"How's it done this year" → yearly.

**Say what the change is measured against** when it matters:
- Daily change is vs. **previous close**
- Longer ranges are vs. **the start of the window**

A yearly "+16%" and a daily "+0.3%" are different kinds of statement; don't let
them blur together.

## Quotes vs. charts

`show_quote` is for *a price right now*, with its own sparkline. If the request
is really about a long historical trend, or about comparing a market against
something that isn't a security (wages, inflation, house prices), that's the
`charts` skill instead — gather the numbers and plot them.
