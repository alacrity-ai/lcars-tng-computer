# Adding a new panel to tng-computer

A panel is a React component displayed on the LCARS wall. The Computer sends it via the `display` tool.

## Pattern overview

Panels are built across **three layers** that must stay in sync:
1. **Type definition** (`packages/shared/src/index.ts`) — shape of the panel's props
2. **Panel component** (`apps/web/src/panels/YourPanel.tsx`) — React render
3. **Registry** (`apps/web/src/panels/registry.tsx`) — wire it up

The registry is typed as a total `Record<PanelView, ComponentType>`, so adding a view name without building a component **will not compile**. This guarantee means `display` can never advertise a panel the wall can't draw.

## Step-by-step

### 1. Define the props interface in shared

Open `packages/shared/src/index.ts` and add a new interface for your panel's props (TypeScript, no circular refs):

```typescript
export interface MyPanelProps {
  title: string;
  data: SomeData[];
  /** Optional description of tricky fields */
  optional?: number;
}
```

**Conventions:**
- Name it `${PanelName}PanelProps`
- JSDoc each field you'll send from Claude
- Be strict with types (no `any` or `Record<string, unknown>`)
- Default props in the component, not the type

### 2. Register the view name in PANEL_VIEWS

Still in `packages/shared/src/index.ts`, add your panel name to the `PANEL_VIEWS` constant array:

```typescript
export const PANEL_VIEWS = [
  "boot",
  "status",
  "text",
  "alert",
  "blank",
  "weather",
  "youtube",
  "results",
  "article",
  "my-panel",  // ← add here, alphabetically or by category
] as const;
```

**Why:** This array is the single source of truth. The `PanelView` type is derived from it, and the registry is typed as a total Record over it, so forgetting this step will break the registry compile.

### 3. Build the React component

Create `apps/web/src/panels/MyPanel.tsx`:

```typescript
import type { MyPanelProps } from "@tng/shared";

export function MyPanel({ title, data }: MyPanelProps) {
  return (
    <div className="my-panel">
      <div className="my-panel-title">{title}</div>
      <div className="my-panel-body">
        {/* Render data here */}
      </div>
    </div>
  );
}
```

**Conventions:**
- Name it `${PanelName}Panel` (PascalCase, no suffix)
- Export as a named export (not default)
- Import and use the props interface from `@tng/shared`
- Handle empty/missing data gracefully (no crashes)
- Use BEM-style class names: `panel-name`, `panel-name-title`, `panel-name-body`
- Keep components simple; split complex renders into sub-functions if needed

### 4. Register in the component registry

Open `apps/web/src/panels/registry.tsx` and add your component:

```typescript
import { MyPanel } from "./MyPanel";

const REGISTRY: Record<PanelView, ComponentType<any>> = {
  boot: BootPanel,
  status: StatusPanel,
  text: TextPanel,
  alert: AlertPanel,
  blank: BlankPanel,
  weather: WeatherPanel,
  youtube: YouTubePanel,
  results: ResultsPanel,
  article: ArticlePanel,
  "my-panel": MyPanel,  // ← add here
};
```

**Why last:** TypeScript will error if the key exists in `PanelView` but no component is assigned. Adding the component forces both sides to exist.

### 5. Test the wall can render it

Start the dev server and fire `display` with your panel:

```bash
npm run dev
# In another terminal, via the console MCP or direct call:
# display({ view: "my-panel", props: { title: "Test", data: [...] } })
```

Watch for TypeScript errors. The type system guarantees the wall can render what you send.

### 6. Teach the Computer to use it — write or update a skill

Runtime usage rules live in `claude/.claude/skills/`, NOT in CLAUDE.md (which
holds only persona and reflexes — see its "Where knowledge lives" section).

- Panel fits an existing capability (a new range on quotes, a new media
  control) → extend that skill.
- Genuinely new capability → add `claude/.claude/skills/<name>/SKILL.md` with
  frontmatter (`name`, `description` phrased around what the *user says*) and
  add a row to the capability table in `claude/CLAUDE.md`.

A panel without a skill is invisible at runtime — the Computer has no
procedure that reaches it, so it will never be displayed. (This happened to
the `news` panel; don't repeat it.)

## Common pitfalls

- **Forgot to add to PANEL_VIEWS**: Registry won't compile; you'll see `Type 'my-panel' is not assignable to type 'PanelView'`
- **Props interface in the component file**: Share types via `@tng/shared`, not local imports; keeps the MCP and webapp in sync
- **Forgetting to export the component as named export**: The registry import will fail
- **Not handling missing/empty data**: A panel that crashes on incomplete props will crash the wall
- **CSS that assumes a specific viewport size**: The LCARS display is full-screen; use responsive units

## Prebuilt SVG assets — the diagram cache

Some diagram panels carry a large, deterministic SVG (the periodic table is
~33k characters) that is expensive for the model to emit and never changes.
Re-emitting it every time is slow — not because the wall is slow, but because
every byte transits the model's context on the way to the `display` tool.

The fix: **resolve the SVG in the console MCP, by reference.** The model passes
`props.svgAsset: "<slug>"` on a `diagram` view instead of `props.svg`. The MCP
(`packages/console-mcp/src/index.ts`, `loadDiagramAsset`) reads
`claude/.claude/skills/diagrams/assets/<slug>.svg` off disk and substitutes it
into `props.svg` before forwarding to the server. The wall and server are
unchanged — they only ever see `svg`.

Why the MCP and not the server: the assets are authored alongside the diagrams
skill (session side), and the MCP runs in that same fence, so it has natural
read access. The server (stack fence) may not. This keeps the resolver where
the files live. Override the directory with `TNG_DIAGRAM_ASSETS_DIR`.

Rules that keep it safe and honest:
- The slug is validated against `^[a-z0-9][a-z0-9-]*$` — no `/`, `.`, or `..`,
  so a reference can never escape the assets dir.
- A missing or misnamed asset throws, and the error surfaces to the model
  (it does not silently render an empty panel).
- Only cache **timeless** content. Anything with a date — prices, standings,
  weather — must never become an asset.

The runtime half of this (when to save, the library of slugs, how to display
by reference) lives in `claude/.claude/skills/diagrams/SKILL.md` under
"Prebuilt assets". Keep the two in sync: a new asset means a new library bullet
there, not a code change here.

## Roadmap panels (don't add yet)

These are intentionally NOT in `PANEL_VIEWS` (see the comment in shared/index.ts):
- `now-playing` (music/Spotify phase)
- `calendar` (planned)
- `web` (generic web content, differs from article)

Advertising them would let `display` succeed while the wall showed a stub message. Add them only when the component lands. (`news`, `chart`, `map`, `image`, and `quote` have all since landed and are registered.)

## Example: adding a simple clock panel

```typescript
// packages/shared/src/index.ts
export interface ClockPanelProps {
  time: string; // "19:30" format
  timezone?: string;
}

export const PANEL_VIEWS = [
  // ... existing ...
  "clock",
] as const;

// apps/web/src/panels/ClockPanel.tsx
import type { ClockPanelProps } from "@tng/shared";

export function ClockPanel({ time, timezone = "UTC" }: ClockPanelProps) {
  return (
    <div className="clock-panel">
      <div className="clock-display">{time}</div>
      <div className="clock-timezone">{timezone}</div>
    </div>
  );
}

// apps/web/src/panels/registry.tsx
import { ClockPanel } from "./ClockPanel";

const REGISTRY: Record<PanelView, ComponentType<any>> = {
  // ... existing ...
  clock: ClockPanel,
};
```

Then CSS styling in the LCARS design system, test in the wall, done.
