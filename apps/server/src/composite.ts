/**
 * Composite panel validation (TNGC-33). The composite view is the one panel
 * whose props can come from PLUGINS, not just the session — so the server
 * enforces the schema's hard limits before anything reaches the wall:
 * depth/block/byte caps, and svg assets by same-origin path only. Unknown
 * block TYPES pass (the wall placards them — additive schema evolution);
 * malformed structure does not.
 */
import {
  COMPOSITE_MAX_BLOCKS,
  COMPOSITE_MAX_BYTES,
  COMPOSITE_MAX_DEPTH,
} from "@tng/shared";

const ACCENTS = new Set(["gold", "peach", "lav", "blue", "red"]);

/** Returns a user-legible error string, or null when valid. */
export function validateComposite(props: Record<string, unknown>): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(props));
  if (bytes > COMPOSITE_MAX_BYTES) {
    return `composite panel too large (${bytes} bytes, max ${COMPOSITE_MAX_BYTES}) — cut content, don't shrink type`;
  }
  if (props.title !== undefined && typeof props.title !== "string") return "title must be a string";
  if (props.accent !== undefined && !ACCENTS.has(props.accent as string)) {
    return `accent must be one of: ${[...ACCENTS].join(", ")}`;
  }
  if (props.columns !== undefined) {
    const c = props.columns;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 3) {
      return "columns must be an integer 1..3";
    }
  }
  if (!Array.isArray(props.blocks) || props.blocks.length === 0) {
    return "blocks (non-empty array) is required";
  }

  let count = 0;
  const walk = (blocks: unknown[], depth: number): string | null => {
    if (depth > COMPOSITE_MAX_DEPTH) return `nesting too deep (max ${COMPOSITE_MAX_DEPTH})`;
    for (const b of blocks) {
      if (typeof b !== "object" || b === null || Array.isArray(b)) return "every block must be an object";
      count++;
      if (count > COMPOSITE_MAX_BLOCKS) return `too many blocks (max ${COMPOSITE_MAX_BLOCKS})`;
      const block = b as Record<string, unknown>;
      if (typeof block.type !== "string" || !block.type) return "every block needs a type";
      if (block.accent !== undefined && !ACCENTS.has(block.accent as string)) {
        return `block accent must be one of: ${[...ACCENTS].join(", ")}`;
      }
      switch (block.type) {
        case "group": {
          if (typeof block.title !== "string") return "group.title (string) is required";
          if (!Array.isArray(block.items)) return "group.items (array) is required";
          const err = walk(block.items, depth + 1);
          if (err) return err;
          break;
        }
        case "gauge": {
          const v = block.value;
          if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 1) {
            return "gauge.value must be a number 0..1";
          }
          break;
        }
        case "sparkline": {
          if (!Array.isArray(block.points) || block.points.some((p) => typeof p !== "number")) {
            return "sparkline.points must be an array of numbers";
          }
          if ((block.points as number[]).length > 200) return "sparkline.points: max 200 points";
          break;
        }
        case "svg": {
          const url = block.assetUrl;
          // Same-origin PATH only: no scheme, no protocol-relative, no
          // traversal. The wall renders it via <img>, so even a hostile
          // asset can't script — but it must still come from our server.
          if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("..")) {
            return "svg.assetUrl must be a same-origin path (starts with /, no ..)";
          }
          break;
        }
        default:
          break; // unknown types render as a placard on the wall
      }
    }
    return null;
  };

  return walk(props.blocks, 1);
}
