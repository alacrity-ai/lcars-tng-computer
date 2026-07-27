# Games on the Computer — brainstorm

**Ten multiplayer game designs where every tricorder is a private controller and
the wall is the shared board.** Grounded in a read of the current cloud
(`apps/tricorder/src/{worker,hub,calendar}.ts`), the link contract
(`packages/contract/src/index.ts`), the plugin system, and the panel pipeline.

Nothing here is committed to. The point is to pick one, then write a real
implementation design.

---

## What the hardware already is

Before the games, an honest inventory. A household game console is an unusual
shape and the interesting designs come from what this shape is *good* at, not
from porting a console game onto it.

| Piece | What it's good at | What it is bad at |
|---|---|---|
| **The wall** | one big public surface everyone looks at together; the board, the scoreboard, the reveal | anything private; anything one person needs to read closely |
| **Each tricorder** | a private screen + keyboard + touch, one per person, already authenticated as a known human | shared attention — if the game is *on* the phone, nobody looks up |
| **The house** | 15 bulbs / 6 zones under deterministic control; TTS on the wall | subtlety — lighting is a mood instrument, not a game mechanic on its own |
| **The brain** (Claude session) | generating content nobody could author in advance; judging fuzzy things; narrating in character | being in a real-time loop — it answers in seconds, not milliseconds |
| **The TenantHub DO** | a single-threaded, authoritative, always-on server per household, already holding sockets to phones and the bridge | long CPU work; it is a coordinator, not a compute box |

The last row is the one people underrate. **The DO is already a lockstep
multiplayer game server** and nobody has noticed yet.

---

## Five constraints that decide every design below

**1. The brain is never in the game loop.**
A model turn is seconds. A buzzer is milliseconds. So: the *rules* are ordinary
code running in the DO, and the brain generates *content* — before the round,
or for the next round while this one is being played. Any design that needs a
model reply between a button press and a screen update is dead on arrival.

**2. Ordering is free, and it is exact.**
The DO is single-threaded per tenant. Two phones buzzing 4 ms apart arrive at
one machine and get serialized by arrival. No client timestamps to trust, no
clock-skew fudging, no tie-break rule to argue about. Most party-game platforms
would kill for this; here it's the default.

**3. There is no server→phone push outside Viewscreen mode.**
`/screen` (TNGC-36) is a real WebSocket, tagged per user (`user:<handle>`), but
it is push-only and exists to carry viewscreen display frames. Everything else
the PWA does is HTTP polling. Turn-based games are fine on polling (1 s feels
instant when you're waiting for four other people). **Real-time games are not.**
Generalizing that socket into a per-user event channel is the single highest-
value platform investment on this page — and it pays off well beyond games.

**4. Guests are hard-refused from plugins, in three places.**
`worker.ts:441`, `:466`, `:478` — *"the guest account has no plugins"*. A party
game whose entire premise is people who don't live here cannot sit behind that
gate. Either the roster gains a per-plugin `guestAllowed` flag (my preference —
it generalizes, and it's an honest statement that lights are not games), or
games live in their own route family outside the plugin gate.

**5. A panel ships to two surfaces.**
The wall reads `packages/panel-renderer` as source; the tricorder viewscreen
reads a prebuilt bundle (`build:vs` + deploy). Learned in TNGC-57, written down
in `docs/sops/adding-new-panels.md`. Games are heavy panel work, so this will
bite unless it's in the checklist from day one.

And one happy accident: **the guest QR (TNGC-57) is already the perfect game
onboarding.** Put it on the wall, a guest scans it, and ten seconds later
they're holding a controller. No account, no app store, no password read aloud.

---

## The ten

Each entry: the fantasy, what's on the wall, what's on each phone, what the
code does versus what the brain does, rough cost, and what platform work it
forces.

---

### 1. Trivia Night — the baseline

> *"Computer, trivia. Five rounds. Go easy on Ariel."*

**Wall.** Category, the question, a big timer ring, and a chip per player that
lights as they lock in — so you can see that everyone has answered without
seeing *what*. Then the reveal, then the standings.

**Phones.** Join, then four lettered buttons. Tap locks; no changing your mind.
A lightning round replaces the buttons with one enormous BUZZ.

**Code vs brain.** Code owns rounds, the deadline, scoring, and buzz ordering.
The brain writes the pack — ten questions, difficulty tuned to who is actually
in the room — *before* round one starts, plus one line of commentary on each
reveal. Content generation and play never overlap in time.

**Cost.** M. Most of it is the shared engine, which everything else reuses.

**Why it's first-ish.** It's the least surprising game here, and that's the
point: it proves join → private input → public reveal → score, and it makes the
buzzer story real.

---

### 2. Household Lore — trivia about *this house*

> *"Whose dentist appointment is on Thursday? Who turned every light off at
> 11:04pm last Tuesday? What did the Computer put on the wall the night of the
> 4th?"*

The data is already there and already structured: the family calendar (D1), the
library of saved panels (D1 + R2), `control_log` (who issued which house
command, and when), the message history. The brain turns it into questions.

**Wall and phones.** Identical to #1 — this is a *content pack*, not a new
engine, which is why it's cheap once #1 exists.

**Cost.** M on top of #1, almost all of it in the question generator and its
guardrails.

**Why it matters.** It is literally impossible on any other platform, and it is
the single best answer to "why does this house have a computer." It is also the
only game here with a real privacy problem: household lore must be off when
guests are in the room, or restricted to a source set that can't embarrass
anyone. Decide that before writing a line of it, not after.

---

### 3. Bluff — write a convincing lie

> Fibbage, and the reason it works here is that every player already has a
> keyboard in their hand.

**Wall.** A prompt with a blank in it. Then every submitted answer, shuffled,
with the truth hidden among them. Then the reveal: who wrote what, and who fell
for whom.

**Phones.** Phase one: type your lie. Phase two: pick from the list — with your
own answer suppressed so you can't vote for yourself.

**Code vs brain.** Code owns submission, shuffling, voting, scoring. The brain
does the two things code can't: generate prompts, and **judge near-duplicates**
— rejecting a "lie" that is really the truth in different clothes ("Nantes" vs
"nantes, france"). That judgment is exactly why this game normally needs a human
host, and it's a legitimate, latency-tolerant use of the model (it happens
during the submission phase, not between a tap and a frame).

**Cost.** M. First game needing free-text input from phones.

---

### 4. Spectrum — the cheapest good game

> Wavelength. One dial, one secret, one clue.

**Wall.** A dial between two poles — *Overrated ←→ Underrated*, *Snack ←→ Meal*
— with the target band hidden.

**Phones.** The clue-giver's phone (and only theirs) shows where the target
actually is; they say a clue out loud. Everyone else drags a slider, and the
wall shows their guesses landing live as little markers on the dial.

**Code vs brain.** Code owns everything. The brain generates spectrum pairs
forever, themed to the room, which is the whole reason this never gets stale.

**Cost.** S — genuinely small. One number per player per round.

**Why I'd build this first.** It is the smallest thing that exercises the entire
engine: join, private state that must never leak, public live reveal, scoring.
If the engine runs Spectrum well it will run six of these ten. And it's the best
guest game on the list — the rules explain themselves in one sentence.

---

### 5. Cipher — Codenames, and the asymmetry is real

**Wall.** The 5×5 word grid, public, tiles flipping color as they're touched.

**Phones.** The spymasters see the same grid with the key overlaid. Everyone
else taps to guess. The important part: the key **never transits the wall** —
it is sent only to the sockets belonging to the two spymasters, so the secrecy
is a server-side fact rather than a promise about where people are looking.

**Code vs brain.** Code owns all the rules. The brain generates themed word sets
(Starfleet, the kitchen, 1990s) — and, when you're a player short, **plays
spymaster**, which is the creative half and therefore the right half to hand to
a model.

**Cost.** M. A grid panel and two different phone views of the same grid.

---

### 6. Night Watch — Werewolf, and the house is the moderator

> The showpiece. This is the one that uses everything.

**Wall.** Day phase: the village, who's alive, the accusation tally building in
real time. Night phase: **the wall goes dark.**

**Phones.** Your secret role, delivered privately at deal time. At night, your
private action — *who do you eliminate?* — visible to nobody else, ever.

**The house.** Lights to zero for the night phase and back up for day, over the
same deterministic control frames the lighting panel already uses. TTS narrates:
*"The village sleeps."* Fifteen bulbs across six zones going dark on cue is not
a gimmick — the night/day cycle *is* the game's structure, and this house can
actually perform it.

**Code vs brain.** Code owns role assignment, phase transitions, and resolution
— all trivially deterministic. The brain narrates the deaths in character, which
is the entire flavor of Werewolf and the job a human moderator is prized for.

**Cost.** M–L. Forces one real architectural question: **may a game plugin drive
another plugin?** Games reaching into lighting is either a clean capability
("a game may request scenes") or an ugly precedent, and the answer shapes the
plugin system generally.

**Why it's the demo.** Every other smart-home party trick is a light show. This
is a house that plays a game *with* you and uses its own body to do it.

---

### 7. Red Alert — real-time co-op, everyone shouting

> Spaceteam, on a wall, in a living room.

**Wall.** The ship. Hull integrity, incoming, the countdown, a klaxon, and the
damage you're all failing to fix.

**Phones.** Each player gets a randomized console of absurd controls — levers,
dials, toggles, *"set the Heisenberg compensator to 4"* — and the instructions
you're given refer to controls on **someone else's** console. So you shout. The
game is really a machine for making a room full of people yell nonsense at each
other, and it is extremely good at it.

**Code vs brain.** Code owns everything and must be *fast* — sub-second, or the
game isn't a game. The brain generates control names and mission flavor between
waves.

**Cost.** L, and it is the **only** design here that genuinely cannot run on
polling. It forces constraint 3: the per-user push socket.

**Note.** Because it forces the hardest platform work, it's a bad first build
and an excellent second-phase target — by then the socket pays for six other
things too.

---

### 8. Holodeck — the AI dungeon master

> *"Computer, run program Taylor One."*

**Wall.** The scene: an image, a map (`MapPanel` already exists), the initiative
order, HP bars, whatever the party can all see.

**Phones.** Your character sheet, your private inventory, your dice, and a text
box for *what do you do?* — including things you'd rather the table didn't
overhear.

**Code vs brain.** Code owns turn order, dice, HP, inventory, and persistence.
The brain is the DM: narration, adjudication, consequence.

**Cost.** L — but note the inversion: this design is **latency-tolerant**. A
ten-second model reply reads as the DM thinking, not as lag. The one game where
the platform's biggest weakness stops being a weakness.

**The real payoff is persistence.** The campaign lives in D1 across weeks. You
resume in March what you started in January, and the house remembers the NPC you
were rude to. Nothing else on this list rewards a household over time like that.

---

### 9. The Bracket — household arguments, settled

**Wall.** A 16-slot tournament bracket. Each matchup comes up, the votes land
visibly, the winner advances, the bracket fills.

**Phones.** One tap. A or B. That is the entire input, and that is the feature.

**Code vs brain.** Code owns the bracket, votes, and ties. The brain seeds it
from a topic — *best snack in this house*, *best Star Trek captain*, *worst
chore* — and writes one line of commentary per matchup.

**Cost.** S.

**Why it's on the list.** It is the most *guest-proof* game here: nothing to
explain, nothing to be bad at, everyone can play while talking about something
else. And the winners persist — the house can hold a reigning champion snack,
which is exactly the kind of dumb permanence that makes a household object feel
alive.

---

### 10. Garble — drawing telephone

**Wall.** Nothing at all during play (secrecy is the mechanic), then the chain
reveal as a filmstrip: drawing → description → drawing → description → the
wreckage at the end.

**Phones.** A canvas, and a text box, alternating down the chain.

**Code vs brain.** Code owns the chain and the pairing. The brain is optional
flavor — captioning, judging the best garble, or standing in for a missing
player.

**Cost.** L — the most new UI on this list. A real drawing surface on the phone,
plus image storage (R2 is already there, holding library payloads).

**Payoff.** Loudest laugh per round of anything here, by a distance.

---

### Also considered

- **Where in the World** — wall shows a photo or clue, phones drop a pin, score
  by distance. `MapPanel` exists; the catch is a pin-droppable map *on the
  phone*, which is more work than it sounds.
- **Jeopardy board** — better as a board *mode* inside #1 than as its own game.
- **Chess and two-player abstracts** — the wall is a beautiful board, but two
  players and five spectators is the wrong shape for a household console.
- **Cards Against Humanity-likes** — deliberately skipped. Kids and guests.

---

## The engine all ten share

Build this once, or build the first game twice.

1. **A match.** Create, then join by a code on the wall — or better, by the
   guest QR pattern that already exists: scan the wall, you're in the game.
   Roster, ready-up, drop-in and drop-out (someone's phone *will* die mid-game).
2. **Phases with server-side deadlines.** A state machine in the DO, with the DO
   alarm API as the clock. Never trust a phone's clock for anything that scores.
3. **Public versus private, enforced server-side.** The one rule that makes all
   of this work: the wall shows what everyone may see; a phone shows what only
   that person may see. A spymaster key must be impossible to fetch from a phone
   that isn't the spymaster — not merely absent from its UI.
4. **One input endpoint.** `POST /api/game/act` on the player's own session
   bearer token, so the actor is their handle and is never spoofable from the
   body (the same discipline the calendar plugin already uses). The DO serializes
   — arrival order *is* the buzzer.
5. **Scores that outlive the evening.** D1, so the house keeps a leaderboard and
   can be asked who's won the most this year.

### Architecture calls I'd make now

- **Cloud-native plugin** (the `calendar` kind — no manifest, no sidecar, no
  `TNG_PLUGINS`), not a sidecar. Games must still work when the Computer is off;
  the brain adds content, and its absence should degrade to a canned pack rather
  than a dead game. That test — *"alive when the Computer is off?"* — is exactly
  the one the plugin SOP now asks first.
- **Content is pre-generated, never in the loop.** Generate the pack, then play
  it. The brain writes round N+1 while the room is arguing about round N.
- **The wall is an output, not a participant.** Public state goes out as panel
  props. This needs one small piece of core work: a way to push a panel with
  *inline* props to a named wall, deterministically, without consuming a session
  turn. The library display path (`display-item` → `display` down-frame →
  dispatched ahead of the queue, no turn consumed) already proves the route
  exists; it just always carries a library item id today.
- **Then the per-user push socket** (constraint 3), which unblocks #7 and makes
  everything else feel instant.
- **Then the guest carve-out** (constraint 4), because a party game that refuses
  the party is a joke.

---

## What I'd actually build, in order

1. **Spectrum (#4)** — smallest possible real game. Proves the engine end to end
   for the cost of one slider and one number.
2. **Trivia (#1)** and **Bluff (#3)** on that engine — two very different input
   modes (choice, free text) over the same machinery, which is how you find out
   whether the engine is actually general.
3. **Night Watch (#6)** as the showpiece, once lighting-from-a-game has a clean
   answer.
4. **Red Alert (#7)** after the push socket lands, or as the reason it lands.
5. **Household Lore (#2)** and **Holodeck (#8)** as the two that no other
   platform can do — the first because the data is here, the second because the
   memory is here.

If only one thing ever ships: **Spectrum plus the guest QR** is a complete party
in about four hundred lines.
