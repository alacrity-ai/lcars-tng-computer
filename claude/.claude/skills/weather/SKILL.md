---
name: weather
description: Weather forecasts — "what's the weather", "forecast for X", "will it rain", "weather for the next N days". Uses the National Weather Service API for US locations and Open-Meteo elsewhere, never web search, which returns unreliable aggregated numbers.
---

# Weather

The `weather` panel takes a location and a list of days. Getting *correct*
numbers into it is the whole job.

## Do not use WebSearch for forecast numbers

Search snippets aggregate several forecast providers into one answer and
routinely produce impossible days — 95°F highs alongside 59°F lows, swings of
twenty degrees between consecutive days. Treat any forecast number from a
search snippet as unusable.

Go to the National Weather Service directly.

## The two-step NWS API

```
1.  https://api.weather.gov/points/{lat},{lng}
    → WebFetch: "Return the exact value of the 'forecast' URL field in the
      properties object."

2.  https://api.weather.gov/gridpoints/{OFFICE}/{X},{Y}/forecast
    → WebFetch: "List every forecast period in order. For each: name,
      isDaytime, temperature, shortForecast, and probabilityOfPrecipitation
      value. Include ALL periods through the end of the forecast, do not
      truncate."
```

No API key. `lat,lng` order here — latitude first.

**Do not shortcut to the HTML page.** `forecast.weather.gov/MapClick.php`
renders only a few days reliably and will silently give you five when you asked
for seven. The gridpoint API returns the full 14 periods.

## Periods are day/night pairs

The API returns alternating daytime and nighttime periods:

- Daytime period `temperature` is that day's **high**
- The following nighttime period `temperature` is that night's **low**

Pair them to build each panel day. The first period may be a partial day
("This Afternoon") — label it "Today". The final period may lack a matching
night; `low` is optional, so just omit it.

Seven panel days needs fourteen periods; count before you display.

## Display

```
display({ view: "weather", props: {
  location: "Pelham, NH",
  units: "F",
  days: [
    { name: "Today",     high: 79, low: 68, conditions: "Showers and thunderstorms", precip: 55 },
    { name: "Wednesday", high: 85, low: 58, conditions: "Partly sunny, PM storms",   precip: 29 },
    …
  ]
}})
```

Shorten `shortForecast` for the wall — "Partly Sunny then Chance Showers And
Thunderstorms" becomes "Partly sunny, PM storms". `precip` is the integer
percentage.

## Speaking

Describe the **shape of the week**, not each day. Find the pattern — where the
weather breaks, when a front clears, when it returns:

> "Storms this afternoon and heavy rain tonight, then a break. Thursday through
> Sunday are clear and settled, highs in the low eighties. Storms return Monday."

Never read seven days of numbers aloud. The panel has them.

## Re-asking within a day

NWS updates its gridpoint forecast several times daily, so a second pull can
return different numbers than the first. That's a normal revision, not a
contradiction — if the user notices the change, say so plainly rather than
implying one of the two was wrong.

## Outside the US — Open-Meteo

NWS covers only US territory (`api.weather.gov/points` 404s elsewhere). For
anywhere else, Open-Meteo is keyless and global. You know the coordinates of
almost every city; no geocoding step needed:

```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=7&temperature_unit=fahrenheit
```

WebFetch prompt: *"For each date in the daily arrays: the date, max temp, min
temp, and precipitation probability. Also translate each weather_code to a
short condition phrase."* (Codes are WMO: 0 clear · 1–3 clouds · 45/48 fog ·
51–67 drizzle/rain · 71–77 snow · 80–82 showers · 95–99 thunderstorms.)

Daily entries already pair max/min — no period-pairing step. Drop
`&temperature_unit=fahrenheit` for Celsius and set `units: "C"` on the panel.

## Locations without a station

Small towns often have no dedicated station. `api.weather.gov/points` resolves
any coordinate to its covering gridpoint, so this always works — but if the
user asks about *historical climate* rather than forecast, the data is
county-level. Say which county you used. (Historical series: see the `charts`
skill.)
