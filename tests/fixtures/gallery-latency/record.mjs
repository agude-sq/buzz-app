// Records ArrowRight navigation through the gallery-latency fixture: the real
// thread grid and media viewer over 8 photos, each original delayed separately.
//
//   bin/node tests/fixtures/gallery-latency/record.mjs <prototype> [label]
//
// <prototype> is a gallery-prototype.ts value: current, pending, placeholder,
// thumbnail or thumbnail+preload. Environment:
//   PRESS_GAP=380  ms between presses: burst 380, dwell 1500, key repeat 40
//   REDUCED=1      prefers-reduced-motion
//   BLURHASH=0     omit imeta blurhash, as images sent from this app do
// Writes test-results/gallery-latency/<label>.{webm,timeline.txt}. Needs
// `bin/pnpm exec playwright install chromium`; compose.sh needs a full ffmpeg.
import { chromium } from "@playwright/test";
import { encode } from "blurhash";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "../../browser/page-errors.mjs";
import { createServer } from "../../browser/vite-server.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const out = join(repo, "test-results", "gallery-latency");
const photos = JSON.parse(
  await readFile(new URL("./photos.json", import.meta.url), "utf8"),
);
const prototype = process.argv[2] ?? "current";
const gap = Number(process.env.PRESS_GAP ?? 380);
const reduced = !!process.env.REDUCED;
const blurhash = process.env.BLURHASH !== "0";
const label =
  process.argv[3] ??
  [prototype, reduced && "reduced", !blurhash && "noblurhash", `${gap}ms`]
    .filter(Boolean)
    .join("-");
// Original latency per photo (ms). The grid loads 1–4 before the viewer opens.
const DELAYS = [600, 700, 650, 800, 2600, 1700, 3200, 2100];
const THUMB_DELAY = 120;
// Paces the simulated person (lead-in, dwell, press cadence); never used to
// wait for the app, which is always awaited by condition.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch();
const assets = await drawPhotos();
const t0 = Date.now();
const requests = [];
const server = await createServer({
  configFile: false,
  envFile: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "gallery-latency-media",
      configureServer(vite) {
        // Not page.route: routing disables the HTTP cache the grid warms.
        vite.middlewares.use("/api/relay/media", async (req, res, next) => {
          const target =
            new URL(req.url ?? "", "http://x").searchParams.get("url") ?? "";
          const match = /\/media\/(\d)\d{63}(\.thumb)?\.jpg$/.exec(target);
          const asset = match && assets[Number(match[1]) - 1];
          if (!asset) return next();
          const thumb = !!match[2];
          const entry = { at: Date.now() - t0, photo: Number(match[1]), thumb };
          requests.push(entry);
          res.on("close", () => {
            if (!res.writableFinished) entry.aborted = Date.now() - t0;
          });
          await pause(thumb ? THUMB_DELAY : DELAYS[entry.photo - 1]);
          if (entry.aborted) return;
          const body = thumb ? asset.thumb : asset.original;
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": body.length,
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          res.end(body);
        });
      },
    },
  ],
});
await server.listen();
await mkdir(out, { recursive: true });
const size = { width: 1280, height: 800 };
const context = await browser.newContext({
  ...(reduced ? { reducedMotion: "reduce" } : {}),
  viewport: size,
  recordVideo: { dir: out, size },
});
const page = await context.newPage();
const videoStart = Date.now();
const pageErrors = watchPageErrors(page);
const search = new URLSearchParams({ galleryPrototype: prototype });
if (!blurhash) search.set("blurhash", "0");
await page.goto(
  `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/gallery-latency.html?${search}`,
);
const tiles = page.locator("[data-media-preview]");
await tiles.first().waitFor();
// Grid tiles 1–4 decode before the viewer opens, as in a real channel.
await page.waitForFunction(() =>
  [...document.querySelectorAll("[data-media-preview]")]
    .slice(0, 4)
    .every((tile) => tile.hasAttribute("data-image-ready")),
);
await pause(600);
await tiles.first().click();
const stage = page.getByRole("group", { name: "Image gallery" });
await stage.waitFor();
const applied = await stage.getAttribute("data-gallery-prototype");
if (applied !== prototype)
  throw new Error(`Stage runs "${applied}", not "${prototype}"`);
await page.waitForFunction(
  () => !document.querySelector("[data-review-opening], [data-review-pending]"),
);
await pause(1000);
await page.evaluate(probe);
const firstPress = Date.now() - videoStart;
for (let press = 0; press < photos.length - 1; press++) {
  await page.evaluate(() => window.__press());
  await page.keyboard.press("ArrowRight");
  await pause(gap);
}
await page.waitForFunction(
  () => {
    const view = document.querySelector('[aria-label="Image gallery"]');
    const image = view?.querySelector("img[data-review-media]");
    return (
      image?.complete &&
      image.naturalWidth &&
      !view.querySelector(
        "[data-gallery-departing], [data-gallery-preview]:not([data-gallery-ready])",
      )
    );
  },
  null,
  { timeout: 20_000 },
);
await pause(1500);
const timeline = await page.evaluate(() => window.__timeline);
const errors = pageErrors.unexplained();
const video = page.video();
await context.close();
await browser.close();
await server.close();
const file = join(out, `${label}.webm`);
await rename(await video.path(), file);
const log = requests.map(
  (r) =>
    `${r.at}ms #${r.photo}${r.thumb ? " thumb" : ""}${r.aborted ? ` (aborted at ${r.aborted}ms)` : ""}`,
);
await writeFile(
  join(out, `${label}.timeline.txt`),
  [
    `firstPressOffsetMs ${firstPress}`,
    ...timeline,
    "",
    "requests (ms from server start):",
    ...log,
  ].join("\n"),
);
console.log([...timeline, "", ...log, "", file].join("\n"));
if (errors.length) {
  console.error("page errors:", errors);
  process.exitCode = 1;
}

/** Logs, per frame, the counter and which photo's pixels are on screen. */
function probe() {
  const start = performance.now();
  const log = [];
  window.__timeline = log;
  window.__press = () =>
    log.push(`${Math.round(performance.now() - start)}ms PRESS ArrowRight`);
  const photo = (image) => /%2F(\d)\d{63}/.exec(image?.src ?? "")?.[1] ?? "?";
  // A preview follows its original in the stage.
  const show = (image, preview) => {
    const n = photo(image);
    if (preview && !preview.hasAttribute("data-gallery-ready"))
      return `${preview.dataset.galleryPreview} ${n}${preview.complete === false ? " (loading)" : ""}`;
    if (preview && Number(getComputedStyle(preview).opacity) > 0.01)
      return `${preview.dataset.galleryPreview}→photo ${n}`;
    return image?.complete && image.naturalWidth
      ? `photo ${n}`
      : `blank (photo ${n} loading)`;
  };
  let last = "";
  const tick = () => {
    const stage = document.querySelector('[aria-label="Image gallery"]');
    if (stage) {
      const image = stage.querySelector("img[data-review-media]");
      const preview = stage.querySelector(
        "[data-gallery-preview]:not([data-gallery-departing])",
      );
      const gone = stage.querySelector("img[data-gallery-departing]");
      const opacity = gone ? Number(getComputedStyle(gone).opacity) : 1;
      const departed = gone
        ? show(
            gone,
            stage.querySelector(
              "[data-gallery-preview][data-gallery-departing]",
            ),
          )
        : undefined;
      const shown = !departed
        ? show(image, preview)
        : stage.hasAttribute("data-gallery-loading")
          ? `${departed} (stale${opacity < 0.99 ? `, opacity ${opacity.toFixed(2)}` : ""}; target loading)`
          : `slide ${departed} → ${show(image, preview)}`;
      const status = [...stage.querySelectorAll('[role="status"]')]
        .map((element) => element.textContent)
        .filter(Boolean);
      const counter = stage.querySelector("[aria-live]")?.textContent ?? "";
      const state = `${counter} | ${shown}${status.length ? ` | status "${status.join(" ")}"` : ""}`;
      if (state !== last) {
        last = state;
        log.push(`${Math.round(performance.now() - start)}ms ${state}`);
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

/** Synthetic landscapes with a large number, a 320px `.thumb.jpg` each (the
 * relay's rendition) and their BlurHash, checked against photos.json. */
async function drawPhotos() {
  const page = await browser.newPage();
  const drawn = await page.evaluate((specs) => {
    const canvas = (width, height) =>
      Object.assign(document.createElement("canvas"), { width, height });
    return specs.map(({ dim, hue }, index) => {
      const [w, h] = dim.split("x").map(Number);
      const full = canvas(w, h);
      const c = full.getContext("2d");
      const u = Math.min(w, h);
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, `hsl(${hue} 70% 72%)`);
      sky.addColorStop(1, `hsl(${hue + 35} 60% 45%)`);
      c.fillStyle = sky;
      c.fillRect(0, 0, w, h);
      c.fillStyle = `hsl(${hue + 180} 90% 85%)`;
      c.beginPath();
      c.arc(w * 0.75, h * 0.22, u * 0.09, 0, Math.PI * 2);
      c.fill();
      for (let layer = 0; layer < 3; layer++) {
        c.fillStyle = `hsl(${hue + 20 * layer} ${40 + 10 * layer}% ${38 - 10 * layer}%)`;
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x <= w; x += w / 80)
          c.lineTo(
            x,
            h * (0.52 + 0.13 * layer) -
              u * 0.08 * Math.sin((x / w) * (4 + 3 * layer) + index + layer) -
              u * 0.03 * Math.sin((x / w) * 23 + 2 * layer),
          );
        c.lineTo(w, h);
        c.fill();
      }
      // 4px stripes: crisp in the original, a grey band in the thumbnail.
      c.fillStyle = "rgb(255 255 255 / 0.75)";
      for (let x = 0; x < w; x += 8) c.fillRect(x, h - u * 0.07, 4, u * 0.03);
      c.fillStyle = "white";
      c.shadowColor = "rgb(0 0 0 / 0.35)";
      c.shadowBlur = u * 0.02;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.font = `bold ${u * 0.4}px sans-serif`;
      c.fillText(String(index + 1), w / 2, h / 2);
      c.textAlign = "left";
      c.textBaseline = "top";
      c.font = `bold ${u * 0.05}px sans-serif`;
      c.fillText(`Photo ${index + 1} of ${specs.length}`, u * 0.04, u * 0.04);
      const scale = 320 / Math.max(w, h);
      const thumb = canvas(Math.round(w * scale), Math.round(h * scale));
      const t = thumb.getContext("2d");
      t.imageSmoothingQuality = "high";
      t.drawImage(full, 0, 0, thumb.width, thumb.height);
      const sample = canvas(
        Math.round(thumb.width / 5),
        Math.round(thumb.height / 5),
      );
      const s = sample.getContext("2d");
      s.imageSmoothingQuality = "high";
      s.drawImage(thumb, 0, 0, sample.width, sample.height);
      return {
        original: full.toDataURL("image/jpeg", 0.9),
        thumb: thumb.toDataURL("image/jpeg", 0.8),
        sample: {
          width: sample.width,
          height: sample.height,
          pixels: [...s.getImageData(0, 0, sample.width, sample.height).data],
        },
      };
    });
  }, photos);
  await page.close();
  const bytes = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const hashes = drawn.map(({ sample }) =>
    encode(
      Uint8ClampedArray.from(sample.pixels),
      sample.width,
      sample.height,
      4,
      3,
    ),
  );
  if (hashes.some((hash, index) => hash !== photos[index].blurhash))
    console.warn(
      `photos.json BlurHashes no longer match the drawn photos:\n${JSON.stringify(hashes)}`,
    );
  return drawn.map(({ original, thumb }) => ({
    original: bytes(original),
    thumb: bytes(thumb),
  }));
}
