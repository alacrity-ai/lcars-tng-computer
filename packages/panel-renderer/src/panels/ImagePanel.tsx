import { useState } from "react";
import type { ImageItem, ImagePanelProps } from "@tng/shared";

/**
 * Library-record / gallery panel.
 * - one image + body  → blurb beside a framed image ("tell me about Nero")
 * - one image alone   → full-bleed framed image
 * - images[] (2+)     → mosaic grid with per-cell captions (comparisons,
 *                       "various examples of…")
 */

function Cell({ item }: { item: ImageItem }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="mosaic-cell">
      {failed ? (
        <div className="image-missing small">Unavailable</div>
      ) : (
        <img
          className="mosaic-img"
          src={item.url}
          alt={item.caption ?? ""}
          onError={() => setFailed(true)}
        />
      )}
      {item.caption && <figcaption className="mosaic-caption">{item.caption}</figcaption>}
    </figure>
  );
}

function Mosaic({ items }: { items: ImageItem[] }) {
  const n = items.length;
  const cols = n <= 2 ? 2 : n <= 3 ? 3 : n === 4 ? 2 : 3;
  return (
    <div className="image-mosaic" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {items.map((item, i) => (
        <Cell key={`${item.url}-${i}`} item={item} />
      ))}
    </div>
  );
}

export function ImagePanel({ url, images, title, caption, body, source }: ImagePanelProps) {
  const [failed, setFailed] = useState(false);
  const mosaic = Array.isArray(images) && images.length >= 2;

  return (
    <div className="image-panel">
      {title && <div className="image-title">{title}</div>}
      {mosaic ? (
        <Mosaic items={images} />
      ) : (
        <div className={body ? "image-body split" : "image-body"}>
          {body && <div className="image-blurb">{body}</div>}
          <figure className="image-figure">
            {failed || !url ? (
              <div className="image-missing">Image unavailable</div>
            ) : (
              <img
                className="image-img"
                src={url}
                alt={caption ?? title ?? ""}
                onError={() => setFailed(true)}
              />
            )}
            {(caption || source) && (
              <figcaption className="image-caption">
                {caption}
                {caption && source && " · "}
                {source && <span className="image-source">{source}</span>}
              </figcaption>
            )}
          </figure>
        </div>
      )}
    </div>
  );
}
