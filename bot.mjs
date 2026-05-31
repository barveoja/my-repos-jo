// bot.mjs — GitHub-Actions-only bid.cars → Telegram bot.
// Scrapes, de-duplicates against a committed state file, and posts rich car
// cards to a Telegram channel. No Cloudflare, no server. Node 20+.
//
// Secrets (GitHub → Settings → Secrets and variables → Actions → Secrets):
//   TG_BOT_TOKEN     bot token from @BotFather
//   TG_CHANNEL_ID    "@channel" or "-100..." (bot must be channel admin)
//   APIFY_TOKEN      (if SCRAPE_MODE=apify)
//   TG_ALERT_CHAT    (optional) your DM chat id for failure alerts
//
// Variables (same screen → Variables):
//   SEARCH_URLS          one or more bid.cars search URLs (comma/newline sep)
//   SCRAPE_MODE          "apify" (default) | "playwright"
//   APIFY_ACTOR          default "lexis-solutions~bid-cars-scraper"
//   RESULTS_PER_SOURCE   default 40
//   MAX_POSTS_PER_RUN    default 12
//   POST_DELAY_MS        default 3500
//   MAX_PHOTOS           default 8   (2-10)
//   DEDUPE_DAYS          default 90
//   TRUST_SOURCE_FILTER  "true" if your search URL already filters to sold/archived
//   PHOTO_MODE           "auto" (default: URL, fall back to upload) | "url" | "upload"

import { readFile, writeFile, mkdir } from "node:fs/promises";

const int = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? Math.trunc(+v) : d);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── config ────────────────────────────────────────────────────────────────
const E = process.env;
const CFG = {
  botToken: req("TG_BOT_TOKEN"),
  channel: req("TG_CHANNEL_ID"),
  alertChat: E.TG_ALERT_CHAT || "",
  mode: (E.SCRAPE_MODE || "playwright").toLowerCase(),
  apifyToken: E.APIFY_TOKEN || "",
  apifyActor: E.APIFY_ACTOR || "lexis-solutions~bid-cars-scraper",
  searchUrls: list(E.SEARCH_URLS),
  resultsPerSource: int(E.RESULTS_PER_SOURCE, 40),
  maxPostsPerRun: int(E.MAX_POSTS_PER_RUN, 12),
  postDelayMs: int(E.POST_DELAY_MS, 3500),
  maxPhotos: clamp(int(E.MAX_PHOTOS, 8), 2, 10),
  dedupeDays: int(E.DEDUPE_DAYS, 90),
  trustSource: String(E.TRUST_SOURCE_FILTER || "").toLowerCase() === "true",
  photoMode: (E.PHOTO_MODE || "auto").toLowerCase(),
};
const API = `https://api.telegram.org/bot${CFG.botToken}`;
const STATE_FILE = "state/seen.json";
const HEARTBEAT_FILE = "state/heartbeat.txt";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function req(k) {
  if (!E[k]) throw new Error(`Missing required secret/var: ${k}`);
  return E[k];
}
function list(s) {
  return (s || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!CFG.searchUrls.length) throw new Error("SEARCH_URLS is empty");

  // 1) scrape every source
  let raw = [];
  for (const url of CFG.searchUrls) {
    const got = CFG.mode === "playwright" ? await viaPlaywright(url) : await viaApify(url);
    console.log(`source → ${got.length} lots  (${url})`);
    raw.push(...got);
  }

  // DEBUG: print the structure of the first scraped object so field mapping can
  // be matched to the real data. Safe to leave on; remove later if you like.
  if (raw.length) {
    console.log("DEBUG raw lot keys:", JSON.stringify(Object.keys(raw[0])));
    console.log("DEBUG raw lot sample:", JSON.stringify(raw[0]).slice(0, 1800));
  }

  // 2) normalize → keep sold (or trust source) → de-dupe within batch
  const inBatch = new Set();
  const lots = raw
    .map(normalizeLot)
    .filter((l) => l && l.id && (CFG.trustSource || l.isSold))
    .filter((l) => (inBatch.has(l.id) ? false : (inBatch.add(l.id), true)));

  // 3) de-dupe against committed state, post oldest-first
  const seen = await loadSeen();
  const fresh = lots.filter((l) => !seen[l.id]).sort((a, b) => (a.soldAtTs || 0) - (b.soldAtTs || 0));
  console.log(`raw=${raw.length} candidates=${lots.length} fresh=${fresh.length}`);

  let posted = 0;
  for (const lot of fresh) {
    if (posted >= CFG.maxPostsPerRun) break;
    try {
      await postLot(lot);
      seen[lot.id] = Date.now();
      posted++;
      if (posted < CFG.maxPostsPerRun) await sleep(CFG.postDelayMs);
    } catch (e) {
      console.error(`post failed ${lot.id}:`, String(e));
    }
  }

  // 4) prune old ids + persist state (+ daily heartbeat)
  prune(seen, CFG.dedupeDays);
  await saveSeen(seen);
  await heartbeat();
  console.log(`posted=${posted}  state size=${Object.keys(seen).length}`);
}

// ── data sources ─────────────────────────────────────────────────────────
async function viaApify(searchUrl) {
  if (!CFG.apifyToken) throw new Error("SCRAPE_MODE=apify but APIFY_TOKEN missing");
  const endpoint =
    `https://api.apify.com/v2/acts/${CFG.apifyActor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(CFG.apifyToken)}&clean=true`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startUrls: [{ url: searchUrl }],
      searchUrls: [searchUrl],
      maxItems: CFG.resultsPerSource,
      includeImages: true,
    }),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

// FREE direct scraper. Loads the page in a real Chromium (which executes the
// site's anti-bot JS, unlike a bare fetch) and AUTO-DISCOVERS the data by
// capturing the JSON the page's own frontend fetches — no hardcoded endpoint
// needed. Falls back to embedded JSON, then visible cards.
async function viaPlaywright(searchUrl) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const captured = [];
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1366, height: 900 },
    });
    // Normal-browser hygiene (not evasion): hide the automation flag.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Optional: inject a logged-in session via exported cookies (BIDCARS_COOKIES
    // secret). Sessions expire, so the bot will need fresh cookies periodically.
    const cookies = parseCookies(E.BIDCARS_COOKIES);
    if (cookies.length) {
      try {
        await ctx.addCookies(cookies);
        console.log(`loaded ${cookies.length} cookies (logged-in mode)`);
      } catch (e) {
        console.warn(`cookie injection failed: ${String(e).slice(0, 120)}`);
      }
    }

    const page = await ctx.newPage();

    // Capture every JSON response and keep the lot-shaped objects.
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const data = await res.json().catch(() => null);
        if (!data) return;
        const lots = findLots(data);
        if (lots.length) {
          captured.push(...lots);
          console.log(`captured ${lots.length} lots from XHR: ${res.url().slice(0, 90)}`);
        }
      } catch {}
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    // Scroll to trigger lazy/paginated XHR until we have enough.
    for (let i = 0; i < 8 && captured.length < CFG.resultsPerSource; i++) {
      await page.mouse.wheel(0, 5000);
      await page.waitForTimeout(1500);
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    if (captured.length) return dedupeById(captured).slice(0, CFG.resultsPerSource);

    // Fallback 1: JSON embedded in the HTML.
    const blob = await page.evaluate(() => {
      const tp = (s) => { try { return JSON.parse(s); } catch { return null; } };
      if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
      for (const el of document.querySelectorAll('script[type="application/json"]')) {
        const j = tp(el.textContent || ""); if (j) return j;
      }
      return null;
    });
    if (blob) { const l = findLots(blob); if (l.length) return l.slice(0, CFG.resultsPerSource); }

    // Fallback 2: bid.cars renders results server-side. Parse the real card.
    const result = await page.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const afterLabel = (s) => clean((s || "").replace(/^[^:]*:/, "")); // drop "Label: "
      const realPhoto = (u) =>
        u && /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !/\/(icons|img\/upd|images)\//i.test(u) && !/\.svg/i.test(u);

      const links = [...document.querySelectorAll('a.item-title[href*="/lot/"], a[href*="/en/lot/"]')];
      const seen = new Set();
      const cards = [];
      let dbg = null;

      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const mId = href.match(/\/lot\/([0-9-]+)/i);
        const lotId = mId ? mId[1] : null;
        if (!lotId || seen.has(lotId)) continue;
        // pick the title-looking link (has text), skip image-only links
        const titleText = clean(link.textContent);
        if (!titleText) continue;
        seen.add(lotId);

        const wrap = link.closest(".wrapper") || link.closest("li, .item, div");
        const q = (sel) => wrap?.querySelector(sel);
        const qt = (sel) => clean(q(sel)?.textContent);

        // VIN + lot are two .vin_title spans
        const vinEls = wrap ? [...wrap.querySelectorAll(".vin_title")].map((e) => clean(e.textContent)) : [];
        const vin = vinEls.find((v) => /^[A-HJ-NPR-Z0-9]{11,17}$/i.test(v)) || vinEls[0] || null;

        // spec icons (alt / tooltip text) + engine text
        const specEls = wrap ? [...wrap.querySelectorAll(".specs > span")] : [];
        const specTexts = specEls.map((s) => ({
          tip: s.getAttribute("data-original-title") || s.querySelector("img")?.getAttribute("alt") || "",
          txt: clean(s.textContent),
        }));
        const findSpec = (re) => specTexts.find((s) => re.test(s.tip))?.tip || null;
        const engine = clean(specTexts.filter((s) => /engine/i.test(s.tip) && s.txt).map((s) => s.txt).join(" ")) || null;

        // list items
        const liText = (cls) => {
          const el = wrap?.querySelector(cls);
          return el ? afterLabel(el.textContent) : null;
        };
        let damage = null, dmgEl = wrap ? [...wrap.querySelectorAll("li")].find((li) => /damage/i.test(li.textContent)) : null;
        if (dmgEl) damage = afterLabel(dmgEl.textContent);
        const [primaryDamage, secondaryDamage] = (damage || "").split("|").map((s) => clean(s));

        const doc = liText(".doc_desc"); // "Clear (New Jersey)"
        const docM = (doc || "").match(/^(.*?)\s*\(([^)]+)\)\s*$/);

        // price / status — parse carefully, no digit-mashing
        const priceText = clean((wrap?.querySelector(".item-price") || wrap)?.textContent || "");
        const soldM = priceText.match(/(?:sold(?:\s*for)?|final\s*bid|purchase\s*price)\D{0,8}\$([\d,]+)/i);
        const bidM = priceText.match(/current\s*bid\D{0,8}\$([\d,]+)/i);
        const estM = priceText.match(/\$[\d,]+\s*-\s*\$[\d,]+/);
        const isSoldCard = /\bsold\b/i.test(priceText);
        const toNum = (s) => (s ? Number(s.replace(/[^\d]/g, "")) : null);

        // Photos: bid.cars uses a lazy slider — scan <img> attrs, srcset,
        // data-* lazy URLs, and CSS background-image, not just <img src>.
        const photoRoot = wrap?.closest("li, .col, .row, [class*='item']")?.parentElement || wrap?.parentElement || wrap;
        const found = new Set();
        if (photoRoot) {
          for (const el of photoRoot.querySelectorAll("*")) {
            if (el.tagName === "IMG") {
              for (const a of ["src", "data-src", "data-original", "data-lazy", "data-flickity-lazyload", "data-echo"]) {
                const v = el.getAttribute(a);
                if (v) found.add(v);
              }
              const ss = el.getAttribute("srcset");
              if (ss) ss.split(",").forEach((p) => found.add(p.trim().split(/\s+/)[0]));
            }
            const st = el.getAttribute("style");
            if (st && /background/i.test(st)) {
              const m = st.match(/url\((['"]?)(.*?)\1\)/i);
              if (m && m[2]) found.add(m[2]);
            }
            for (const at of el.attributes || []) {
              if (/^data-/.test(at.name) && /\.(jpe?g|png|webp)/i.test(at.value)) found.add(at.value);
            }
          }
        }
        const imgs = [...found].map((u) => (u.startsWith("//") ? "https:" + u : u)).filter(realPhoto);

        // title → year/make/model/series
        const tm = titleText.match(/^(\d{4})\s+([A-Za-z-]+)\s+(.+)$/);
        const year = tm ? tm[1] : null;
        const make = tm ? tm[2] : null;
        const rest = tm ? tm[3] : titleText;
        const [model, series] = rest.split(",").map((s) => clean(s));

        const card = {
          lotId, vin, url: link.href, title: titleText,
          year, make, model, series,
          auction: qt(".item-seller"),
          seller: liText(".seller_desc"),
          location: liText(".loc_desc"),
          odometerText: liText(".odo_desc"),
          transmission: findSpec(/automatic|manual|cvt/i),
          fuel: findSpec(/gasoline|diesel|hybrid|electric|petrol|gas/i),
          drive: findSpec(/wheel drive|awd|fwd|rwd|4wd/i),
          keys: findSpec(/key/i) ? "Yes" : null,
          engine,
          primaryDamage: primaryDamage || null,
          secondaryDamage: secondaryDamage || null,
          titleType: docM ? clean(docM[1]) : doc,
          titleState: docM ? clean(docM[2]) : null,
          runDrive: liText(".status_item"),
          status: isSoldCard ? "Sold" : "Active",
          salePrice: soldM ? toNum(soldM[1]) : null,
          currentBid: bidM ? toNum(bidM[1]) : null,
          estimate: estM ? estM[0] : null,
          images: [...new Set(imgs)],
        };
        if (!dbg) {
          const sliderEl = photoRoot?.querySelector("[class*='slider'],[class*='carousel'],[class*='swiper'],[class*='gallery'],[class*='photo'],[class*='image'],figure");
          let imgHtml = sliderEl ? sliderEl.outerHTML.slice(0, 1500) : null;
          // also surface any element whose data-* attrs reference a jpg/png/webp
          let dataAttrHit = null;
          if (photoRoot) {
            for (const el of photoRoot.querySelectorAll("*")) {
              for (const at of el.attributes || []) {
                if (/\.(jpe?g|png|webp)/i.test(at.value) && !/\/(icons|img\/upd|images)\//i.test(at.value)) {
                  dataAttrHit = `${el.tagName}.${el.className} [${at.name}]=${at.value.slice(0, 120)}`;
                  break;
                }
              }
              if (dataAttrHit) break;
            }
          }
          dbg = { photoCount: card.images.length, firstPhoto: card.images[0] || null, dataAttrHit, imgHtml };
        }
        cards.push(card);
      }
      return { cards, dbg };
    });
    console.log("DEBUG parse sample:", JSON.stringify(result.dbg));
    if (!result.cards.length)
      console.warn("Playwright found 0 lots — page may be challenged/blocked on this IP (see README).");
    return result.cards;
  } finally {
    await browser.close();
  }
}

// Walk arbitrary JSON and pull out objects that look like vehicle lots.
function findLots(blob) {
  const out = [];
  const isLot = (o) =>
    o && typeof o === "object" && !Array.isArray(o) &&
    (o.vin || o.VIN || o.maskedVin || o.lotNumber || o.lot_number || o.lotId || o.lot_id ||
      ((o.make || o.manufacturer) && (o.model || o.year)));
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (isLot(n)) out.push(n);
    for (const v of Object.values(n)) walk(v);
  })(blob);
  return out;
}

function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (const o of arr) {
    const id = String(
      o.lotId || o.lot_id || o.lotNumber || o.lot_number || o.lot || o.vin || o.VIN || JSON.stringify(o).slice(0, 60)
    );
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(o);
  }
  return out;
}

// Accepts cookies exported from a browser extension (Cookie-Editor / EditThisCookie)
// — a JSON array — and maps them to Playwright's addCookies() shape.
function parseCookies(raw) {
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { console.warn("BIDCARS_COOKIES is not valid JSON"); return []; }
  if (!Array.isArray(arr)) arr = arr?.cookies || [];
  const ss = (v) => {
    const s = String(v || "").toLowerCase();
    if (s.includes("no_restriction") || s === "none") return "None";
    if (s.includes("strict")) return "Strict";
    return "Lax";
  };
  return arr
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const out = {
        name: c.name,
        value: String(c.value ?? ""),
        domain: c.domain,
        path: c.path || "/",
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
        sameSite: ss(c.sameSite),
      };
      const exp = c.expires ?? c.expirationDate;
      if (exp && Number(exp) > 0) out.expires = Math.floor(Number(exp));
      return out;
    });
}

// ── normalization (rich field capture) ─────────────────────────────────────
function normalizeLot(r) {
  if (!r || typeof r !== "object") return null;
  const id = String(
    pick(r, ["lotId", "lot_id", "lotNumber", "lot", "lot_number", "id"]) || pick(r, ["vin", "VIN"]) || ""
  ).trim();
  if (!id) return null;

  const status = String(pick(r, ["status", "auctionStatus", "saleStatus", "lotStatus"]) || "").toLowerCase();
  const salePrice = num(pick(r, ["salePrice", "soldPrice", "finalBid", "purchasePrice"]));
  const currentBid = num(pick(r, ["currentBid", "highBid"]));
  const soldRaw = pick(r, ["saleDate", "soldDate", "sale_date", "auctionDate", "dateSold", "saleDateTime"]);
  const soldAtTs = toTs(soldRaw);
  const isSold = /sold|purchas/.test(status) || salePrice > 0;

  return {
    id,
    isSold,
    soldAtTs,
    title: String(pick(r, ["title", "name", "vehicleTitle"]) || "").trim() || null,
    soldAtText: typeof soldRaw === "string" ? soldRaw : soldAtTs ? new Date(soldAtTs).toISOString().slice(0, 10) : null,
    salePrice,
    currentBid,
    estimate: pick(r, ["estimate", "estimateRange"]),
    saleStatus: pick(r, ["status", "saleStatus"]),
    currency: pick(r, ["currency", "currencyCode"]) || "USD",
    estRetail: num(pick(r, ["estimatedRetailValue", "estRetailValue", "acv", "retailValue", "estimatedValue"])),

    year: pick(r, ["year", "modelYear"]),
    make: pick(r, ["make", "manufacturer", "brand"]),
    model: pick(r, ["model"]),
    series: pick(r, ["series", "trim", "version", "modelDetail"]),
    body: pick(r, ["bodyStyle", "body", "bodyType", "vehicleType"]),

    engine: pick(r, ["engine", "engineType", "engineSize", "displacement"]),
    cylinders: pick(r, ["cylinders", "cyl"]),
    fuel: pick(r, ["fuel", "fuelType"]),
    transmission: pick(r, ["transmission", "gearbox"]),
    drive: pick(r, ["drive", "driveType", "drivetrain", "driveline"]),
    colorExt: pick(r, ["color", "exteriorColor", "extColor"]),
    colorInt: pick(r, ["interiorColor", "intColor", "trimColor"]),

    odometer: pick(r, ["odometer", "mileage", "miles", "odometerValue"]),
    odometerText: pick(r, ["odometerText"]),
    odometerUnit: pick(r, ["odometerUnit", "mileageUnit"]) || "mi",
    odometerStatus: pick(r, ["odometerStatus", "odometerBrand", "mileageStatus"]),

    primaryDamage: pick(r, ["primaryDamage", "damage", "primary_damage", "lossType"]),
    secondaryDamage: pick(r, ["secondaryDamage", "secondary_damage"]),
    keys: pick(r, ["keys", "hasKeys", "keysAvailable"]),
    runDrive: pick(r, ["runAndDrive", "runDrive", "conditionCode", "driveable", "saleStatusDetail"]),

    titleType: pick(r, ["titleType", "documentType", "title_type", "titleBrand", "title"]),
    titleState: pick(r, ["titleState", "documentState", "stateOfTitle"]),
    vin: pick(r, ["vin", "VIN", "maskedVin"]),

    auction: pick(r, ["auction", "auctionName", "source", "auctionHouse", "saleSource"]),
    seller: pick(r, ["seller", "sellerName"]),
    location: pick(r, ["location", "yard", "saleLocation", "branch", "yardName"]),
    city: pick(r, ["city", "saleCity"]),
    state: pick(r, ["state", "saleState", "region"]),
    country: pick(r, ["country", "saleCountry"]),

    url: pick(r, ["sourceUrl", "url", "lotUrl", "link"]),
    images: collectImages(r),
  };
}

function collectImages(r) {
  const cand = pick(r, ["lotImages", "images", "photos", "imageUrls", "gallery"]) || [];
  const arr = Array.isArray(cand) ? cand : [cand];
  const urls = arr
    .map((x) => (typeof x === "string" ? x : x?.url || x?.src || x?.full || x?.large || x?.hd))
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  const thumb = pick(r, ["thumbnail_image", "thumbnail", "image", "mainImage"]);
  if (typeof thumb === "string" && /^https?:\/\//.test(thumb)) urls.unshift(thumb);
  return [...new Set(urls)];
}

const pick = (o, ks) => { for (const k of ks) if (o[k] != null && o[k] !== "") return o[k]; return undefined; };
const num = (v) => { if (v == null) return null; const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
const toTs = (v) => { if (!v) return 0; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };

// ── caption (rich, sectioned, ≤1024 chars) ─────────────────────────────────
function buildCaption(l) {
  const L = [];
  const head = [l.year, l.make, l.model, l.series].filter(Boolean).join(" ") || l.title || `Lot ${l.id}`;
  L.push(`🚗 <b>${esc(head)}</b>`);
  if (l.body) L.push(`<i>${esc(l.body)}</i>`);

  // sale / bid line
  const sale = [];
  if (l.salePrice > 0) sale.push(`💰 <b>Sold ${money(l.salePrice, l.currency)}</b>`);
  else if (l.currentBid != null) sale.push(`🔨 Current bid ${money(l.currentBid, l.currency)}`);
  if (l.soldAtText) sale.push(`📅 ${esc(l.soldAtText)}`);
  if (sale.length) L.push(sale.join("  ·  "));
  if (!l.salePrice && l.estimate) L.push(`📊 Est. ${esc(l.estimate)}`);
  if (l.estRetail > 0) L.push(`📈 Est. retail ${money(l.estRetail, l.currency)}`);

  // auction / location
  const loc = [l.auction && l.auction.toUpperCase(), [l.city, l.state].filter(Boolean).join(", ") || l.location, l.country]
    .filter(Boolean).map(esc).join(" — ");
  if (loc) L.push(`🏁 ${loc}`);

  // specs
  const specs = [];
  if (l.odometerText) specs.push(`Odometer: ${esc(l.odometerText)}`);
  else if (l.odometer != null) specs.push(`Odometer: ${esc(fmt(l.odometer))} ${esc(l.odometerUnit)}${l.odometerStatus ? ` (${esc(l.odometerStatus)})` : ""}`);
  const power = [l.engine, l.cylinders && `${esc(l.cylinders)}cyl`, l.fuel, l.transmission, l.drive].filter(Boolean).map(esc).join(" · ");
  if (power) specs.push(power);
  const colors = [l.colorExt, l.colorInt].filter(Boolean).map(esc).join(" / ");
  if (colors) specs.push(`Color: ${colors}`);
  if (specs.length) L.push("\n🔧 <b>Specs</b>\n• " + specs.join("\n• "));

  // condition
  const cond = [];
  if (l.primaryDamage) cond.push(`Primary: ${esc(l.primaryDamage)}`);
  if (l.secondaryDamage) cond.push(`Secondary: ${esc(l.secondaryDamage)}`);
  const title = [l.titleState, l.titleType].filter(Boolean).map(esc).join(" – ");
  if (title) cond.push(`Title: ${title}`);
  const yn = (v) => (/^(y|yes|true|1)$/i.test(String(v)) ? "Yes" : /^(n|no|false|0)$/i.test(String(v)) ? "No" : esc(String(v)));
  if (l.keys != null) cond.push(`Keys: ${yn(l.keys)}`);
  if (l.runDrive != null) cond.push(`Run & Drive: ${yn(l.runDrive)}`);
  if (cond.length) L.push("\n⚠️ <b>Condition</b>\n• " + cond.join("\n• "));

  // identifiers + tags + link
  if (l.vin) L.push(`\n🔑 VIN: <code>${esc(String(l.vin))}</code>`);
  L.push(`#️⃣ Lot <code>${esc(l.id)}</code>${l.seller ? ` · Seller: ${esc(l.seller)}` : ""}`);
  const tags = [l.make, l.model, l.year].filter(Boolean).map((s) => "#" + String(s).replace(/[^a-z0-9]+/gi, ""));
  if (tags.length) L.push(tags.join(" "));
  if (l.url) L.push(`🔗 <a href="${esc(l.url)}">View lot</a>`);

  return clip(L.filter(Boolean).join("\n"), 1024);
}

// ── Telegram posting (with URL→upload auto-fallback + 429 backoff) ──────────
async function postLot(lot) {
  const caption = buildCaption(lot);
  const photos = lot.images.slice(0, CFG.maxPhotos);
  const mode = CFG.photoMode;

  if (photos.length === 0) {
    await tgJson("sendMessage", { chat_id: CFG.channel, text: caption, parse_mode: "HTML" });
    return;
  }
  const wantUrlFirst = mode === "url" || mode === "auto";
  if (wantUrlFirst) {
    try {
      await sendByUrl(photos, caption);
      return;
    } catch (e) {
      if (mode === "url") throw e;
      console.warn(`URL post failed (${String(e).slice(0, 120)}), retrying via upload…`);
    }
  }
  await sendByUpload(photos, caption); // mode === "upload" or auto-fallback
}

async function sendByUrl(photos, caption) {
  if (photos.length >= 2) {
    const media = photos.map((url, i) => ({ type: "photo", media: url, ...(i === 0 ? { caption, parse_mode: "HTML" } : {}) }));
    return tgJson("sendMediaGroup", { chat_id: CFG.channel, media });
  }
  return tgJson("sendPhoto", { chat_id: CFG.channel, photo: photos[0], caption, parse_mode: "HTML" });
}

async function sendByUpload(photos, caption) {
  const form = new FormData();
  const media = [];
  let i = 0;
  for (const url of photos) {
    const buf = await fetchImage(url);
    if (!buf) continue;
    const name = `f${i}`;
    form.append(name, new Blob([buf]), `${name}.jpg`);
    media.push({ type: "photo", media: `attach://${name}`, ...(i === 0 ? { caption, parse_mode: "HTML" } : {}) });
    i++;
  }
  if (i === 0) return tgJson("sendMessage", { chat_id: CFG.channel, text: caption, parse_mode: "HTML" });
  form.append("chat_id", String(CFG.channel));
  if (i === 1) {
    // single photo: sendPhoto with the one attachment
    const f2 = new FormData();
    f2.append("chat_id", String(CFG.channel));
    f2.append("caption", caption);
    f2.append("parse_mode", "HTML");
    f2.append("photo", form.get("f0"), "f0.jpg");
    return postForm("sendPhoto", f2);
  }
  form.append("media", JSON.stringify(media));
  return postForm("sendMediaGroup", form);
}

async function fetchImage(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, referer: "https://bid.cars/" } });
    if (!r.ok) throw new Error(`img ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) throw new Error(`not image (${ct})`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn(`image fetch failed ${url}: ${String(e).slice(0, 80)}`);
    return null;
  }
}

async function tgJson(method, payload, attempt = 0) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleTg(method, res, () => tgJson(method, payload, attempt + 1), attempt);
}
async function postForm(method, form, attempt = 0) {
  const res = await fetch(`${API}/${method}`, { method: "POST", body: form });
  return handleTg(method, res, () => postForm(method, form, attempt + 1), attempt);
}
async function handleTg(method, res, retry, attempt) {
  const data = await res.json().catch(() => ({}));
  if (data.ok) return data;
  if (res.status === 429 && attempt < 5) {
    const wait = ((data?.parameters?.retry_after ?? 2 ** attempt) + 1) * 1000;
    console.warn(`429 on ${method}; waiting ${wait}ms`);
    await sleep(wait);
    return retry();
  }
  if (res.status >= 500 && attempt < 3) { await sleep(1500 * (attempt + 1)); return retry(); }
  throw new Error(`Telegram ${method} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
}

// ── state (dedupe) ──────────────────────────────────────────────────────────
async function loadSeen() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { return {}; }
}
async function saveSeen(obj) {
  await mkdir("state", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(obj));
}
function prune(seen, days) {
  const cutoff = Date.now() - days * 86400000;
  for (const [k, ts] of Object.entries(seen)) if (Number(ts) < cutoff) delete seen[k];
}
async function heartbeat() {
  await mkdir("state", { recursive: true });
  await writeFile(HEARTBEAT_FILE, new Date().toISOString().slice(0, 10) + "\n");
}

// ── utils ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => Number(String(n).replace(/[^0-9.]/g, "")).toLocaleString("en-US");
const money = (n, cur) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); }
  catch { return `$${fmt(n)}`; }
};
const clip = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

// ── run + failure alert ─────────────────────────────────────────────────────
main().catch(async (err) => {
  console.error("BOT FAILED:", err);
  if (CFG.alertChat && CFG.botToken) {
    try {
      await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.alertChat, text: `⚠️ bid.cars bot failed:\n${String(err).slice(0, 500)}` }),
      });
    } catch {}
  }
  process.exit(1);
});
