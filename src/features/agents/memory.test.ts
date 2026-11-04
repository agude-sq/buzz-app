import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentMemories,
  MEMORY_CACHE_MS,
  type MemoryListing,
  type MemoryReader,
} from "./memory";

afterEach(() => {
  vi.useRealTimers();
});

const agent = "a".repeat(64);
const viewer = "c".repeat(64);
const listing = (...bodies: string[]): MemoryListing => ({
  entries: bodies.map((body, i) => ({
    slug: `mem/${body}`,
    body,
    eventId: i.toString(16).padStart(64, "0"),
    createdAt: 1,
  })),
  partial: false,
});

/** A reader whose every read waits until `answer` is called. */
function pending() {
  const answers: ((listing: MemoryListing) => void)[] = [];
  const pages: ((page: MemoryListing) => void)[] = [];
  const read = vi.fn<MemoryReader>(
    (_agent, _signal, _slug, onPage) =>
      new Promise((resolve) => {
        answers.push(resolve);
        if (onPage) pages.push(onPage);
      }),
  );
  const answer = (value: MemoryListing) => answers.shift()?.(value);
  return { read, answer, pages };
}

const slugs = (snapshot: { listing?: MemoryListing }) =>
  snapshot.listing?.entries.map((entry) => entry.body);

async function readOnce(
  owner: ReturnType<typeof createAgentMemories>,
  answer: (value: MemoryListing) => void,
  value: MemoryListing,
) {
  const view = owner.capability.open(agent);
  const done = view.refresh();
  answer(value);
  await done;
  expect(view.snapshot().status).toBe("ready");
  view.dispose();
}

it("shows a kept listing before the relay answers, then replaces it with streamed and final entries", async () => {
  const { read, answer, pages } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, listing("stale", "kept"));
  const view = owner.capability.open(agent);
  const done = view.refresh();
  // The cache hit renders at once, while the read goes on.
  expect(view.snapshot().status).toBe("loading");
  expect(slugs(view.snapshot())).toEqual(["kept", "stale"]);
  expect(read).toHaveBeenCalledTimes(2);
  // A streamed page replaces the cached entry with the same slug.
  pages.at(-1)?.({
    entries: [
      {
        slug: "mem/stale",
        body: "fresh",
        eventId: "f".repeat(64),
        createdAt: 2,
      },
    ],
    partial: false,
  });
  expect(slugs(view.snapshot())).toEqual(["kept", "fresh"]);
  // The completed read replaces the whole listing: a removed memory goes.
  answer(listing("fresh"));
  await done;
  expect(view.snapshot().status).toBe("ready");
  expect(slugs(view.snapshot())).toEqual(["fresh"]);
  view.dispose();
});

it("releases a kept listing 30 seconds after its view closes", async () => {
  vi.useFakeTimers();
  const { read, answer } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, listing("kept"));
  vi.advanceTimersByTime(MEMORY_CACHE_MS - 1);
  let view = owner.capability.open(agent);
  void view.refresh();
  expect(slugs(view.snapshot())).toEqual(["kept"]);
  answer(listing("kept"));
  await vi.waitFor(() => expect(view.snapshot().status).toBe("ready"));
  view.dispose();
  vi.advanceTimersByTime(MEMORY_CACHE_MS);
  view = owner.capability.open(agent);
  void view.refresh();
  expect(view.snapshot()).toEqual({ status: "loading" });
  view.dispose();
});

it.each(["clear", "dispose"] as const)(
  "drops kept listings at once when the session is %sed",
  async (end) => {
    const { read, answer } = pending();
    const owner = createAgentMemories(read, viewer, () => true);
    await readOnce(owner, answer, listing("kept"));
    owner[end]();
    if (end === "dispose") {
      expect(() => owner.capability.open(agent)).toThrow();
      return;
    }
    const view = owner.capability.open(agent);
    void view.refresh();
    expect(view.snapshot()).toEqual({ status: "loading" });
    view.dispose();
  },
);
