---
name: lists
description: Family lists — "add milk to the shopping list", "show the shopping list", "check off the dishes", "what's left on the packing list", "start a new list", clearing done items, removing items or whole lists.
---

# Family lists

One `lists` tool does everything. Lists are shared by the whole household —
"my list" and "our list" both mean the family's. Resolve by the NAME the
person said ("shopping", "the packing list") — the tool matches
case-insensitively and strips a trailing "list".

## Routing

| Heard | Call |
|---|---|
| "Add X to the Y list" | `add {list: Y, text: X, user}` |
| "Show the Y list", "put the shopping list up" | `display {list: Y}` |
| "What's left on Y?", "what's on the list?" | `read {list: Y}` → speak the unchecked items |
| "What lists do we have?" | `read {}` → speak names + progress |
| "Check off X", "we got the milk", "X is done" | `check {list, item: X, user}` |
| "Uncheck X", "we actually still need X" | `uncheck {list, item: X, user}` |
| "Take X off the list" | `remove_item {list, item: X, user}` |
| "Start a new list called Y" | `create {name: Y, category?, user}` |
| "Clear the done ones", "clean up the list" | `clear_completed {list}` |
| "Delete the Y list" | confirm first, then `remove_list {list: Y}` |

`user` = the channel event's user, always — attribution is who added or
claimed the item.

## Judgment

- **`add` auto-creates a missing list** and returns `createdList: true` —
  say so naturally ("Started a shopping list and added milk"). Set
  `category` when the name makes it obvious (shopping | chores | todo |
  packing | other); never interrogate for one.
- "The list" with no name and more than one list existing → `read {}` and
  ask ONE short question, unless context (a list already on screen, or the
  conversation) makes it obvious.
- Item matching is by text — pass what was said; if the tool reports an
  ambiguity, offer its candidates rather than guessing.
- Checked items stay visible (struck) until someone asks to clear them —
  don't clear on your own initiative.
- After any write, if a list panel is currently on screen, `display` it
  again so the wall reflects the change.

## Speaking results

Keep it short: "Added milk." · "Milk — checked off." · "Four left:
paper towels, eggs, coffee, batteries." For a just-emptied list: "That's
everything — the list is done." Never read item ids or JSON aloud.
