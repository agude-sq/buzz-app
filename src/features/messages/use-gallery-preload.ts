import { useEffect, useRef, type RefObject } from "react";
import type { Attachment } from "../relay/contracts";
import { saveData } from "../relay/media";

// PROTOTYPE (gallery-prototype.ts): `thumbnail` holds previews in the memory
// cache; `thumbnail+preload` also warms originals around the selection.

/** Original requests in flight at once; the visible image loads outside this. */
const WARM_CONCURRENCY = 2;
/** About 96 MB of decoded RGBA (6000×4000). */
const MAX_WARM_PIXELS = 24_000_000;
const MAX_WARM_BYTES = 25_000_000;

/** Hold every gallery thumbnail so a selected image can show its preview at once. */
export function usePrefetchedPreviews(sources: readonly string[]) {
  const key = sources.join("\n");
  useEffect(() => {
    if (!key) return;
    const images = key.split("\n").map((source) => {
      const image = new Image();
      image.src = source;
      return image;
    });
    return () => {
      for (const image of images) image.src = "";
    };
  }, [key]);
}

/** Large originals are not decoded ahead of a visit. */
export function warmable(attachment: Attachment): boolean {
  const { width = 0, height = 0 } = attachment.dimensions ?? {};
  return (
    width * height <= MAX_WARM_PIXELS &&
    (attachment.size ?? 0) <= MAX_WARM_BYTES
  );
}

/** Decode the next two originals in the direction of travel and the previous
 * one. Requests that leave that window are cancelled: a released `<img>` keeps
 * downloading in Chromium unless its source is cleared. */
export function useWarmOriginals(
  sources: readonly (string | undefined)[] | undefined,
  index: number,
  direction: RefObject<number>,
) {
  const warmers = useRef(
    new Map<string, { image: HTMLImageElement; settled: boolean }>(),
  );
  const pump = useRef<() => void>(undefined);
  const key = sources?.map((source) => source ?? "").join("\n");
  useEffect(() => {
    const list = key?.split("\n") ?? [];
    const step = direction.current;
    const wanted =
      key === undefined || saveData()
        ? []
        : [index + step, index + 2 * step, index - step].flatMap(
            (at) => list[at] || [],
          );
    const keep = new Set([list[index], ...wanted]);
    for (const [source, entry] of warmers.current) {
      if (keep.has(source)) continue;
      if (!entry.settled) entry.image.src = "";
      warmers.current.delete(source);
    }
    pump.current = () => {
      for (const source of wanted) {
        const loading = [...warmers.current.values()].filter(
          (entry) => !entry.settled,
        ).length;
        if (loading >= WARM_CONCURRENCY) return;
        if (warmers.current.has(source)) continue;
        const image = new Image();
        image.fetchPriority = "low";
        const entry = { image, settled: false };
        const settle = () => {
          if (entry.settled) return;
          entry.settled = true;
          pump.current?.();
        };
        image.onload = () => void image.decode().then(settle, settle);
        image.onerror = settle;
        warmers.current.set(source, entry);
        image.src = source;
      }
    };
    pump.current();
  }, [key, index, direction]);
  useEffect(() => {
    const active = warmers.current;
    return () => {
      pump.current = undefined;
      for (const entry of active.values())
        if (!entry.settled) entry.image.src = "";
      active.clear();
    };
  }, []);
}
