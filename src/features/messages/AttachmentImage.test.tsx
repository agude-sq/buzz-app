// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { AttachmentImage } from "./AttachmentImage";
import { imageDimensions, rememberImageDimensions } from "./image-dimensions";

const source = "https://image.test/one.png";
const dimensions = { width: 1200, height: 100 };
// Only identity is consumed by the geometry cache, not session capabilities.
const session = () => ({}) as RelaySession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  owner: RelaySession,
  url = source,
  metadata?: typeof dimensions,
) {
  return render(
    <AttachmentImage
      session={owner}
      attachment={{
        url,
        kind: "image",
        ...(metadata ? { dimensions: metadata } : {}),
      }}
      source={url}
    />,
  );
}

function decode(view: ReturnType<typeof render>) {
  const image = view.container.querySelector("img");
  if (!image) throw new Error("Missing attachment image");
  Object.defineProperties(image, {
    naturalWidth: { value: dimensions.width },
    naturalHeight: { value: dimensions.height },
  });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  Object.defineProperty(image, "decode", { value: vi.fn(() => gate) });
  fireEvent.load(image);
  expect(image.decode).toHaveBeenCalledOnce();
  return {
    release: () => act(async () => resolve()),
    fail: () => act(async () => reject(new Error("decode failed"))),
  };
}

it("keeps compact geometry through decoding and unavailable sources", async () => {
  const attachment = { url: source, kind: "image" as const, dimensions };
  const view = render(
    <AttachmentImage attachment={attachment} source={source} compact />,
  );
  const square = { width: "100%", height: "0px", paddingBottom: "100%" };
  expect(view.getByRole("link")).toHaveStyle(square);
  await decode(view).release();
  expect(view.getByRole("link")).toHaveStyle(square);
  view.rerender(
    <AttachmentImage attachment={attachment} source={undefined} compact />,
  );
  expect(view.getByRole("status")).toHaveTextContent("Image unavailable");
  expect(view.getByRole("status")).toHaveStyle(square);
});

for (const metadata of [undefined, { width: 700, height: 900 }]) {
  it(`retains learned geometry across remount with ${metadata ? "wrong" : "missing"} metadata, but still decodes pixels`, async () => {
    const owner = session();
    const first = mount(owner, source, metadata);
    const pending = decode(first);
    expect(first.getByRole("link")).not.toHaveAttribute("data-image-ready");
    await pending.release();
    expect(first.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    first.unmount();
    const next = mount(owner, source, metadata);
    expect(next.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
    expect(next.container.querySelector("img")).toHaveStyle({
      visibility: "hidden",
    });
    const retry = decode(next);
    await retry.fail();
    expect(next.getByRole("link")).toHaveStyle({ aspectRatio: "360 / 30" });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
  });
}

it("isolates geometry by session and exact source; absent sources cannot borrow it", async () => {
  const owner = session();
  const first = mount(owner);
  await decode(first).release();
  first.unmount();
  for (const [nextOwner, url] of [
    [session(), source],
    [owner, `${source}?v=2`],
  ] as const) {
    const next = mount(nextOwner, url);
    expect(next.getByRole("link").style.aspectRatio).toBe("");
    next.unmount();
  }
  const unavailable = render(
    <AttachmentImage
      session={owner}
      attachment={{ url: source, kind: "image" }}
      source={undefined}
      cached
    />,
  );
  expect(unavailable.container.querySelector("span")?.style.aspectRatio).toBe(
    "",
  );
});

it("a retired decode cannot seed geometry for a later mount", async () => {
  const owner = session();
  const first = mount(owner);
  const pending = decode(first);
  first.unmount();
  await pending.release();
  expect(imageDimensions(owner, source)).toBeUndefined();
  const next = mount(owner);
  expect(next.getByRole("link").style.aspectRatio).toBe("");
});

it("bounds retained geometry and refreshes a source on successful decode", () => {
  const owner = session();
  for (let i = 0; i < 512; i++)
    rememberImageDimensions(owner, `${source}/${i}`, dimensions);
  rememberImageDimensions(owner, `${source}/0`, dimensions);
  rememberImageDimensions(owner, `${source}/512`, dimensions);
  expect(imageDimensions(owner, `${source}/0`)).toEqual(dimensions);
  expect(imageDimensions(owner, `${source}/1`)).toBeUndefined();
  expect(imageDimensions(owner, `${source}/512`)).toEqual(dimensions);
});

const blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const original = (view: ReturnType<typeof render>) => {
  const image = view.container.querySelector("img");
  if (!image) throw new Error("Missing attachment image");
  return image;
};

it("a failed original keeps its preview with a Retry that requests it again until it loads", async () => {
  const view = render(
    <AttachmentImage
      attachment={{ url: source, kind: "image", dimensions, blurhash }}
      source={source}
    />,
  );
  const first = original(view);
  const frame = first.closest("[data-media-preview]");
  const preview = view.container.querySelector("canvas");
  fireEvent.error(first);
  expect(view.getByRole("status")).toHaveTextContent("Couldn't load image");
  // The frame, its preview and its image stay mounted; only the link goes.
  expect(view.container.querySelector("[data-image-failed]")).toBe(frame);
  expect(frame).toHaveStyle({ width: "360px", aspectRatio: "1200 / 100" });
  expect(frame).not.toHaveAttribute("href");
  expect(view.queryByRole("link")).not.toBeInTheDocument();
  expect(view.container.querySelector("canvas")).toBe(preview);
  // The failed original is not requested again until Retry.
  expect(original(view)).toBe(first);
  expect(original(view)).not.toHaveAttribute("src");

  const retry = view.getByRole("button", { name: "Retry image" });
  retry.focus();
  fireEvent.click(retry);
  expect(view.getByRole("status")).toHaveTextContent("Loading image…");
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  expect(original(view)).toBe(first);
  expect(original(view)).toHaveAttribute("src", source);
  fireEvent.error(original(view));
  expect(view.getByRole("status")).toHaveTextContent("Couldn't load image");
  expect(retry).not.toHaveAttribute("aria-busy");
  expect(original(view)).not.toHaveAttribute("src");

  fireEvent.click(retry);
  fireEvent.load(original(view));
  expect(view.queryByRole("status")).not.toBeInTheDocument();
  // A focused Retry hands focus to the image it restored, and the image that
  // loaded is the one shown, not requested again.
  expect(view.getByRole("link")).toBe(frame);
  expect(view.getByRole("link")).toHaveFocus();
  expect(original(view)).toBe(first);
  expect(original(view)).toHaveAttribute("src", source);
  expect(view.container.querySelector("canvas")).toBe(preview);
  await decode(view).release();
  expect(view.getByRole("link")).toHaveAttribute("data-image-ready");
});

it("a failed frame drops the click trap and role that would expose it as a link", () => {
  const attachment = { url: source, kind: "image" as const, dimensions };
  const view = render(
    <AttachmentImage attachment={attachment} source={source} />,
  );
  const frame = view.getByRole("link");
  // React traps clicks on the element of any onClick (for Safari) and never
  // removes the trap; Chromium exposes an anchor with it as a link.
  expect(frame.onclick).toBeTypeOf("function");
  fireEvent.error(original(view));
  expect(frame).toHaveAttribute("role", "none");
  expect(frame).not.toHaveAttribute("href");
  expect(frame.onclick).toBeNull();

  // A frame that mounts already failed matches one that failed later.
  const other = render(
    <AttachmentImage attachment={attachment} source={source} />,
  );
  const failed = other.container.querySelector("[data-image-failed]");
  expect(failed).toHaveAttribute("role", "none");
  expect((failed as HTMLAnchorElement).onclick).toBeNull();
  other.unmount();

  fireEvent.click(view.getByRole("button", { name: "Retry image" }));
  fireEvent.load(original(view));
  expect(view.getByRole("link")).toBe(frame);
  expect(frame).not.toHaveAttribute("role");
  expect(frame.onclick).toBeTypeOf("function");
});

it("a focused image that fails hands focus to its Retry", () => {
  const view = render(
    <AttachmentImage
      attachment={{ url: source, kind: "image", dimensions }}
      source={source}
    />,
  );
  view.getByRole("link").focus();
  fireEvent.error(original(view));
  expect(view.getByRole("button", { name: "Retry image" })).toHaveFocus();

  // Focus elsewhere stays where it is.
  fireEvent.click(view.getByRole("button", { name: "Retry image" }));
  fireEvent.load(original(view));
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  view.rerender(
    <AttachmentImage
      attachment={{ url: `${source}?v=2`, kind: "image", dimensions }}
      source={`${source}?v=2`}
    />,
  );
  fireEvent.error(original(view));
  expect(outside).toHaveFocus();
  outside.remove();
});

it("Retry never reaches an enclosing opener and ignores presses while pending", () => {
  const open = vi.fn();
  const view = render(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Stands in for an enclosing opener.
    // biome-ignore lint/a11y/noStaticElementInteractions: Stands in for an enclosing opener.
    <div onClick={open}>
      <AttachmentImage
        attachment={{ url: source, kind: "image", dimensions }}
        source={source}
      />
    </div>,
  );
  fireEvent.error(original(view));
  const retry = view.getByRole("button", { name: "Retry image" });
  fireEvent.click(retry);
  expect(open).not.toHaveBeenCalled();
  const pending = original(view);
  expect(pending).toHaveAttribute("src", source);
  fireEvent.click(retry);
  fireEvent.click(
    view.getByRole("button", { name: "Couldn't load image. Retry" }),
  );
  expect(original(view)).toBe(pending);
  expect(original(view)).toHaveAttribute("src", source);
});

it.each([
  [undefined, "image"],
  ["image 2 of 4", "image 2 of 4"],
])(
  "offers a round Retry with its own name and hint for small frames: %s",
  async (name, named) => {
    const user = userEvent.setup();
    const view = render(
      <AttachmentImage
        attachment={{ url: source, kind: "image", dimensions }}
        source={source}
        name={name}
      />,
    );
    fireEvent.error(original(view));
    const compact = view.getByRole("button", {
      name: `Couldn't load ${named}. Retry`,
    });
    expect(compact).toHaveAttribute("data-image-retry", "icon");
    expect(
      view.getByRole("button", { name: `Retry ${named}` }),
    ).toHaveAttribute("data-image-retry", "label");
    await user.hover(compact);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `Couldn't load ${named}. Retry`,
    );
  },
);

it("keeps the +N tile as the gallery link, and a new source after a failure loads normally", () => {
  const attachment = { url: source, kind: "image" as const, dimensions };
  const overflow = render(
    <AttachmentImage
      attachment={attachment}
      source={source}
      overlayCount={3}
    />,
  );
  fireEvent.error(original(overflow));
  expect(overflow.getByRole("link")).toHaveTextContent("+3");
  expect(overflow.queryByRole("status")).not.toBeInTheDocument();
  overflow.unmount();

  const view = render(
    <AttachmentImage attachment={attachment} source={source} />,
  );
  fireEvent.error(original(view));
  expect(view.getByRole("status")).toHaveTextContent("Couldn't load image");
  const next = `${source}?v=2`;
  view.rerender(
    <AttachmentImage attachment={{ ...attachment, url: next }} source={next} />,
  );
  expect(view.queryByRole("status")).not.toBeInTheDocument();
  expect(original(view)).toHaveAttribute("src", next);
  expect(view.getByRole("link")).toBeInTheDocument();
});
