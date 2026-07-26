---
name: guests
description: Letting visitors onto the Tricorder — "display the guest QR code", "my friends are here, let them in", "how do my guests use the tricorder", and ending guest access when the evening is over.
---

# Guests

Visitors get onto the Tricorder by **scanning a QR code off the wall**. They
land in the PWA already signed in as the household guest — nothing to type,
no password said out loud in a room full of people.

## Putting it up

`guest_qr` does everything in one call: it mints the invite AND displays it.

- **"Display the guest QR code" / "my friends want to use the tricorder" /
  "let my guests in"** → `guest_qr({})`
- **A longer window** — "good for the night", "we'll be here a while" →
  `minutes` (5–720). Default **60**.
- **A bigger party** → `maxClaims` (1–50). Default **20** phones.
- **Another room's wall** → `wall`, same rule as `display`.

Then say what it opened, briefly and out loud — the window matters:

> "Guest access is open. The code is on the wall for the next hour — up to
> twenty phones."

Two things worth saying once, if it's the first time tonight:

- **Showing the code opens guest access** until it expires. It is a door.
- **Minting again replaces the old code**, so "put it back up" is always safe
  — the previous QR stops working the moment the new one appears.

## What a guest can actually do

Guests talk to you and see the wall. That's it. They are refused the family
calendar, anyone's library, the plugins (lights and the rest), and the
viewscreen — those need attribution, and the guest identity is shared. Their
session expires on its own after **24 hours**.

So: answer a guest's questions, show them things, play them music. If one asks
for something household-only, say plainly that it's for the household and
offer what you can do instead. Never work around it.

## Ending it

When the evening's over, the household admin taps **Rotate guest password** in
the Tricorder admin console (Admin → Guest). That revokes every guest session
*and* kills any live QR in one stroke. You don't have a tool for this — if
asked to "kick the guests out", say that's the button and where it is.

An admin can also disable the guest account outright in the same console;
that stops new scans too.

## Don't

- **Never save a guest QR to the library, and never `recall` one.** The invite
  dies, the panel doesn't — a saved code is a picture of a door that no longer
  opens. If someone wants it back, mint a fresh one.
- **Don't read the invite URL aloud or display it as text.** The QR is the
  whole delivery mechanism; a spoken token helps nobody in the room.
- **Don't offer the guest password instead.** It's the admin's fallback, not
  yours to hand out.

## Plain QR codes

The `qr` view on `display` takes any `{url, title?, caption?}` — use it when
someone wants a link handed to a phone in the room ("put that on the wall so I
can scan it"). For guest access always use `guest_qr`; it mints the credential
the plain panel can't.
