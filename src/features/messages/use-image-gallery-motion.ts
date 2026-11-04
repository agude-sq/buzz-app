import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/** Shared directional navigation recipe for sent images and draft media. */
export const galleryMotion = {
  distance: 40,
  duration: 0.2,
  ease: [0.19, 1, 0.22, 1] as const,
};

type DepartingImage = {
  url: string;
  source: string;
  transform: string;
  direction: number;
  /** Its original was showing; otherwise its preview departs with it. */
  settled: boolean;
};

/** Keep the outgoing DOM image alive until its replacement can slide into view.
 * PROTOTYPE: a `progressive` stage slides at once, previews moving with images. */
export function useImageGalleryMotion(
  stage: RefObject<HTMLDivElement | null>,
  image: RefObject<HTMLImageElement | null>,
  url: string | undefined,
  source: string | undefined,
  progressive = false,
) {
  const [departing, setDeparting] = useState<DepartingImage>();
  const prepare = useCallback(
    (direction: number, settled = true) => {
      if (
        !url ||
        !source ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        setDeparting(undefined);
        return;
      }
      // Rapid navigation while loading should keep the last decoded picture.
      const previous =
        !progressive &&
        stage.current?.hasAttribute("data-gallery-loading") &&
        departing
          ? departing
          : {
              url,
              source,
              settled,
              transform: image.current
                ? getComputedStyle(image.current).transform
                : "none",
            };
      setDeparting({ ...previous, direction });
    },
    [url, source, stage, image, departing, progressive],
  );
  useLayoutEffect(() => {
    if (!departing) return;
    const container = stage.current;
    const incoming = image.current;
    const outgoing = Array.from(
      container?.querySelectorAll<HTMLElement>("[data-gallery-departing]") ??
        [],
    );
    const arriving = Array.from(
      container?.querySelectorAll<HTMLElement>(
        "[data-gallery-preview]:not([data-gallery-departing])",
      ) ?? [],
    );
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (
      departing.url === url ||
      !container ||
      !incoming?.animate ||
      !outgoing.length ||
      reducedMotion?.matches
    ) {
      setDeparting(undefined);
      return;
    }
    const animations: Animation[] = [];
    let cancelled = false;
    const clear = () => {
      cancelled = true;
      delete container.dataset.galleryLoading;
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
    };
    const finish = () => {
      for (const element of outgoing) element.style.visibility = "hidden";
      clear();
      setDeparting((current) => (current === departing ? undefined : current));
    };
    const start = () => {
      if (cancelled) return;
      // A dimmed stale picture leaves from its current opacity.
      const opacities = outgoing.map((element) =>
        Number(getComputedStyle(element).opacity || 1),
      );
      delete container.dataset.galleryLoading;
      const distance = departing.direction * galleryMotion.distance;
      const timing = {
        duration: galleryMotion.duration * 1000,
        easing: `cubic-bezier(${galleryMotion.ease.join(",")})`,
      };
      for (const [index, element] of outgoing.entries())
        animations.push(
          element.animate(
            [
              { translate: "0px 0px", opacity: opacities[index] ?? 1 },
              { translate: `${-distance}px 0px`, opacity: 0 },
            ],
            { ...timing, fill: "forwards" },
          ),
        );
      const [arrival, ...previews] = [incoming, ...arriving].map((element) =>
        element.animate(
          [
            { translate: `${distance}px 0px`, opacity: 0 },
            { translate: "0px 0px", opacity: 1 },
          ],
          timing,
        ),
      );
      if (arrival) {
        animations.push(arrival, ...previews);
        arrival.onfinish = finish;
      }
    };
    if (progressive || incoming.complete) start();
    else {
      container.dataset.galleryLoading = "";
      incoming.addEventListener("load", start, { once: true });
      incoming.addEventListener("error", finish, { once: true });
    }
    window.addEventListener("resize", finish, { once: true });
    reducedMotion?.addEventListener("change", finish);
    return () => {
      clear();
      incoming.removeEventListener("load", start);
      incoming.removeEventListener("error", finish);
      window.removeEventListener("resize", finish);
      reducedMotion?.removeEventListener("change", finish);
    };
  }, [stage, image, url, departing, progressive]);
  return { departing, prepare };
}
