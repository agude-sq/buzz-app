/** TEMPORARY: compares gallery loading strategies in one build. The chosen
 * strategy replaces this switch; record each with tests/fixtures/gallery-latency. */
const GALLERY_PROTOTYPES = [
  "current",
  "pending",
  "placeholder",
  "thumbnail",
  "thumbnail+preload",
] as const;
export type GalleryPrototype = (typeof GALLERY_PROTOTYPES)[number];

/** `?galleryPrototype=` wins over `localStorage["buzz:gallery-prototype"]`. */
export function galleryPrototype(): GalleryPrototype {
  try {
    const value = (
      new URLSearchParams(window.location.search).get("galleryPrototype") ??
      window.localStorage.getItem("buzz:gallery-prototype")
    )?.replaceAll(" ", "+"); // An unescaped `+` in a query decodes as a space.
    return GALLERY_PROTOTYPES.find((item) => item === value) ?? "current";
  } catch {
    return "current";
  }
}
