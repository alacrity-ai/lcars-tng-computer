---
name: charts
description: Plotting data on the wall — "chart X", "graph X", "plot X", "show me a trend of X", "compare X and Y over time". Covers the chart panel's shape, choosing line/bar/pie, thinning dense series, and handling series whose scales differ by orders of magnitude.
---

# Charts

"Chart/graph/plot X" → the `chart` panel. Gather the numbers first (your own
knowledge for well-established data; WebSearch when it should be current), then
display, then speak one sentence of takeaway.

```
display({ view: "chart", props: {
  title: "Median US Household Income",
  kind: "line",              // line | bar | pie
  unit: "$",                 // $/€/£ prefix; anything else suffixes
  series: [{ name?, points: [{ label: "1990", value: 29943 }, …] }],
  xLabel?, yLabel?, source?  // cite source when data came from the web
}})
```

## Picking a kind

- **line** — trends over time; multiple series allowed for comparisons.
  Keep ≤ ~40 points per series: thin dense data to representative intervals
  (decades, years) rather than dumping every data point.
- **bar** — comparing categories; single series, ≤ 12 bars.
- **pie** — composition/shares; single series, ≤ 8 slices.

## Values

Plain numbers — no strings, no formatting. The panel formats ($1.2M, 45k) and
builds its own axes. Units go in `unit`, never in the point labels.

Estimated or approximate data is fine — say so spoken and in `source`
("approximate, various sources").

## Series with wildly different scales

The panel has one y-axis. Plotting two series whose ranges differ by orders of
magnitude (household income ~$80k against the S&P 500 at ~7,000) flattens one
into a line along the floor — technically accurate, visually a lie.

**Index both to a common base year = 100** and plot the indices:

```
value_indexed = 100 * (value_year / value_baseyear)
```

Then:
- `yLabel: "Indexed, 1990 = 100"`
- Omit `unit` — the numbers are ratios, not quantities.
- State the transformation in `source` AND say it aloud. The user asked for
  prices; you gave them growth rates. That substitution must be audible.

This turns a scale problem into a genuinely better answer — indexed series
compare *growth*, which is almost always the real question behind "plot A
against B."

## Nominal vs. real

Long economic series are usually nominal unless stated. If the span is more
than a decade or two, say which you used. "Both figures are nominal, not
adjusted for inflation" is one short sentence and prevents a wrong conclusion.

## Speaking it

One sentence of takeaway — the shape and its magnitude:

> "Beef prices rose roughly forty-fold over the century, most of it after 1970."

Never read data points aloud. If two series diverge, the ratio between them is
usually the story ("stocks outran wages by about six to one").

## Sourcing

Well-established historical data can come from your own knowledge. Anything
that should be *current* — a stock level, this year's figure, a recent
release — must be searched; your training cutoff will silently be wrong.
Cite what you used in `source` and list URLs in the terminal reply.

Useful, fetchable, no-auth sources:
- **NOAA NCEI Climate at a Glance** — county/state/national temperature and
  precipitation time series. JSON by appending `.json` to the time-series URL:
  `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/time-series/{STATE}-{FIPS}/tavg/{months}/{end month}/{start}-{end}.json`
  (`/3/8/` = a 3-month window ending in August, i.e. meteorological summer).
- **FRED** (St. Louis Fed) — US economic series.
- **Census Bureau** — income, population, housing.
