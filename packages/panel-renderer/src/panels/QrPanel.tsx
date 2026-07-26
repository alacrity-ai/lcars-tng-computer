import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { QrPanelProps } from "@tng/shared";

/**
 * A scannable code on the wall (TNGC-57).
 *
 * The matrix is computed here from `url` rather than shipped as an image, so
 * props stay tiny, the code stays crisp at any wall size, and the Tricorder
 * viewscreen renders it identically. Modules are drawn dark-on-light inside an
 * LCARS frame — inverted codes read badly on a lot of phone cameras, and a
 * code nobody can scan is worse than an ugly one.
 *
 * `expiresAt` is load-bearing: the first caller (`guest_qr`) encodes a live
 * credential, so a panel recalled after the invite died must say EXPIRED
 * instead of quietly showing a door that no longer opens.
 */

/** Auto-fit version, level M — survives the wall's glare and a phone at an angle. */
const ECC = "M";
/** Quiet zone in modules. 4 is the spec minimum; scanners get unhappy below it. */
const QUIET = 4;

/** qrcode-generator's byte mode reads `charCodeAt & 0xff` (Latin-1). Feeding it
    the UTF-8 bytes as a binary string keeps ASCII identical and makes non-ASCII
    payloads encode correctly instead of garbling. */
function utf8Binary(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b);
  return out;
}

/** All dark modules as one SVG path — one node instead of ~1500 rects. */
function modulesToPath(qr: ReturnType<typeof qrcode>): string {
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
  }
  return d;
}

function remaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Expires in under a minute";
  if (mins < 60) return `Expires in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function QrPanel({ url, title, caption, expiresAt, hint }: QrPanelProps) {
  // Ticks only while an expiry is being counted down; a plain QR never re-renders.
  const [now, setNow] = useState(() => Date.now());
  const live = typeof expiresAt === "number" && Number.isFinite(expiresAt);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [live]);

  const code = useMemo(() => {
    if (typeof url !== "string" || url.trim() === "") return { error: "Nothing to encode." };
    try {
      const qr = qrcode(0, ECC);
      qr.addData(utf8Binary(url), "Byte");
      qr.make();
      return { path: modulesToPath(qr), size: qr.getModuleCount() + QUIET * 2 };
    } catch {
      // Only reachable past version 40 (~2 KB) — a URL never gets there.
      return { error: "Too much data to encode as a QR code." };
    }
  }, [url]);

  const expired = live && (expiresAt as number) <= now;

  return (
    <div className="qr-panel">
      {title && <div className="qr-title">{title}</div>}
      <div className={expired ? "qr-code expired" : "qr-code"}>
        {"error" in code ? (
          <div className="qr-error">{code.error}</div>
        ) : (
          <svg className="qr-svg" viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges">
            <rect width={code.size} height={code.size} fill="#f6f2e8" />
            <path d={code.path} fill="#08080c" />
          </svg>
        )}
        {expired && <div className="qr-expired-stamp">Expired</div>}
      </div>
      {caption && !expired && <div className="qr-caption">{caption}</div>}
      {expired && <div className="qr-caption expired">This code no longer works — ask for a new one.</div>}
      {(hint || live) && (
        <div className="qr-foot">
          {hint && <span className="qr-hint">{hint}</span>}
          {live && !expired && <span className="qr-expiry">{remaining(expiresAt as number, now)}</span>}
        </div>
      )}
    </div>
  );
}
