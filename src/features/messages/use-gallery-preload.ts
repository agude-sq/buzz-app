import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../relay/contracts";
import { saveData } from "../relay/media";

/** Original requests in flight at once; the visible image loads outside this. */
const WARM_CONCURRENCY = 2;
/** About 96 MB of decoded RGBA (6000×4000). */
const MAX_WARM_PIXELS = 24_000_000;
const MAX_WARM_BYTES = 25_000_000;

/** Hold every gallery thumbnail so a selected image can show its preview at
 * once. Returns the thumbnails that failed: browsers retry a failed image for
 * each new element, so those images go straight to their fallback frame. */
export function usePrefetchedPreviews(sources: readonly string[]) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const key = sources.join("\n");
  useEffect(() => {
    if (!key) return;
    const images = key.split("\n").map((source) => {
      const image = new Image();
      image.onerror = () =>
        setFailed((current) => new Set(current).add(source));
      image.src = source;
      return image;
    });
    return () => {
      for (const image of images) {
        image.onerror = null;
        image.src = "";
      }
    };
  }, [key]);
  return failed;
}

/** Large originals are not decoded ahead of a visit. */
export function warmable(attachment: Attachment): boolean {
  const { width = 0, height = 0 } = attachment.dimensions ?? {};
  return (
    width * height <= MAX_WARM_PIXELS &&
    (attachment.size ?? 0) <= MAX_WARM_BYTES
  );
}

type Warmer = { image: HTMLImageElement; settled: boolean };

// Clearing the source fires `error`, which must not count as settling.
function cancel({ image, settled }: Warmer) {
  if (settled) return;
  image.onload = image.onerror = null;
  image.src = "";
}

/** Decode the next two originals in the direction of travel and the previous
 * one. Requests that leave that window are cancelled: a released `<img>` keeps
 * downloading in Chromium unless its source is cleared.
 *
 * Returns `release`, which takes over an original the viewer stopped showing
 * before it loaded, so it too is cancelled once it leaves the window. */
export function useWarmOriginals(
  sources: readonly (string | undefined)[],
  index: number,
  direction: number,
) {
  const warmers = useRef(new Map<string, Warmer>());
  const pump = useRef<() => void>(undefined);
  const track = useCallback((source: string, image: HTMLImageElement) => {
    const warmer = { image, settled: false };
    const settle = () => {
      if (warmer.settled) return;
      warmer.settled = true;
      pump.current?.();
    };
    image.onload = () => void image.decode().then(settle, settle);
    image.onerror = settle;
    warmers.current.set(source, warmer);
  }, []);
  const key = sources.map((source) => source ?? "").join("\n");
  useEffect(() => {
    const list = key.split("\n");
    const wanted = saveData()
      ? []
      : [index + direction, index + 2 * direction, index - direction].flatMap(
          (at) => list[at] || [],
        );
    const keep = new Set([list[index], ...wanted]);
    for (const [source, warmer] of warmers.current) {
      if (keep.has(source)) continue;
      cancel(warmer);
      warmers.current.delete(source);
    }
    pump.current = () => {
      for (const source of wanted) {
        const loading = [...warmers.current.values()].filter(
          (warmer) => !warmer.settled,
        ).length;
        if (loading >= WARM_CONCURRENCY) return;
        if (warmers.current.has(source)) continue;
        const image = new Image();
        image.fetchPriority = "low";
        track(source, image);
        image.src = source;
      }
    };
    pump.current();
  }, [key, index, direction, track]);
  useEffect(() => {
    const active = warmers.current;
    return () => {
      pump.current = undefined;
      for (const warmer of active.values()) cancel(warmer);
      active.clear();
    };
  }, []);
  // The photo just left is the new window's previous one, so it keeps loading
  // until the selection moves past it.
  return useCallback(
    (image: HTMLImageElement) => {
      const source = image.getAttribute("src");
      if (!source || image.complete) return;
      // A warmer for the same source already holds this request.
      if (warmers.current.has(source)) image.src = "";
      else track(source, image);
    },
    [track],
  );
}
