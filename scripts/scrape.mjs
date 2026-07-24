// Eczacı Haber Merkezi - kaynak tarama betiği.
// config/sources.json içindeki her kaynağı tarar, config/data/news.json dosyasını üretir.
// "auto" tipi kaynaklarda önce RSS keşfi denenir; bulunamazsa kaynak "needs-config"
// olarak işaretlenir (uydurma/hatalı veri üretmek yerine şeffaf biçimde durum bildirilir).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, '..');
const SOURCES_PATH = path.join(BASE_DIR, 'config', 'sources.json');
const DATA_PATH = path.join(BASE_DIR, 'data', 'news.json');

const MAX_ITEMS_PER_SOURCE = 40;
const MAX_TOTAL_ITEMS = 500;
const FETCH_TIMEOUT_MS = 15000;
const DEDUPE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 gün
const USER_AGENT =
  'Mozilla/5.0 (compatible; EczaciHaberMerkeziBot/1.0; +https://github.com/eczyalcin/dip-radar)';
const FEED_DISCOVERY_PATHS = ['/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml'];

const TR_MONTHS = {
  ocak: 0,
  şubat: 1,
  subat: 1,
  mart: 2,
  nisan: 3,
  mayıs: 4,
  mayis: 4,
  haziran: 5,
  temmuz: 6,
  ağustos: 7,
  agustos: 7,
  eylül: 8,
  eylul: 8,
  ekim: 9,
  kasım: 10,
  kasim: 10,
  aralık: 11,
  aralik: 11,
};

const rssParser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
});

function hashId(link) {
  return crypto.createHash('sha1').update(link).digest('hex').slice(0, 16);
}

function normalizeTitle(title) {
  return title
    .replace(/^\d{1,2}[./]\d{1,2}[./]\d{4}\s*\|?\s*/, '') // TEB tarzı baştaki tarih öneki
    .toLocaleLowerCase('tr')
    .replace(/[.,;:!?'"()[\]{}\-–—’‘“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function itemTimeMs(item) {
  return Date.parse(item.publishedAt || item.firstSeenAt || item.fetchedAt || 0);
}

// Aynı haberin farklı kaynaklarca (ör. TEB duyurusunu bir eczacı odasının
// aynen yeniden yayımlaması) tekrar tekrar gösterilmesini önler: normalize
// edilmiş başlığı aynı VE tarihleri birbirine yakın (DEDUPE_WINDOW_MS)
// öğeleri tek bir karta indirger. Sadece başlık eşleşmesi yeterli
// sayılmaz; "Vefat ve Başsağlığı" gibi genel başlıklar farklı zamanlarda
// gerçekten farklı duyurular olabilir.
function dedupeItems(items, sourcePriority) {
  const byTitle = new Map();
  for (const it of items) {
    const key = normalizeTitle(it.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(it);
  }

  const result = [];
  for (const group of byTitle.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    group.sort((a, b) => itemTimeMs(a) - itemTimeMs(b));
    let cluster = [group[0]];

    const flushCluster = () => {
      if (cluster.length === 1) {
        result.push(cluster[0]);
        return;
      }
      cluster.sort((a, b) => (sourcePriority.get(a.source) ?? 99) - (sourcePriority.get(b.source) ?? 99));
      const canonical = { ...cluster[0] };
      const seenNames = new Set([canonical.sourceName]);
      canonical.alsoFrom = [];
      for (const other of cluster.slice(1)) {
        if (seenNames.has(other.sourceName)) continue;
        seenNames.add(other.sourceName);
        canonical.alsoFrom.push({ sourceName: other.sourceName, link: other.link });
      }
      result.push(canonical);
    };

    for (let i = 1; i < group.length; i += 1) {
      if (itemTimeMs(group[i]) - itemTimeMs(group[i - 1]) <= DEDUPE_WINDOW_MS) {
        cluster.push(group[i]);
      } else {
        flushCluster();
        cluster = [group[i]];
      }
    }
    flushCluster();
  }

  return result;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseTurkishDate(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();

  let m = t.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  m = t.match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})/i);
  if (m) {
    const [, d, monthName, y] = m;
    const mo = TR_MONTHS[monthName];
    if (mo !== undefined) {
      const dt = new Date(Date.UTC(Number(y), mo, Number(d)));
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    }
  }

  return null;
}

async function discoverFeedUrl(homepage) {
  try {
    const res = await fetchWithTimeout(homepage);
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const href = $('link[type="application/rss+xml"], link[type="application/atom+xml"]')
        .first()
        .attr('href');
      if (href) return new URL(href, homepage).toString();
    }
  } catch {
    // sessizce yut, aşağıdaki bilinen yollarla devam et
  }

  for (const candidate of FEED_DISCOVERY_PATHS) {
    try {
      const url = new URL(candidate, homepage).toString();
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const text = await res.text();
        if (text.includes('<rss') || text.includes('<feed')) return url;
      }
    } catch {
      // sıradaki adaya geç
    }
  }

  return null;
}

async function scrapeRss(feedUrl) {
  const feed = await rssParser.parseURL(feedUrl);
  return (feed.items || [])
    .map((item) => ({
      title: (item.title || '').trim(),
      link: item.link,
      publishedAt: item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : null),
    }))
    .filter((it) => it.title && it.link);
}

function extractListItems(html, listUrl, selectors) {
  const $ = cheerio.load(html);
  const items = [];

  $(selectors.item).each((_, el) => {
    const root = $(el);
    const linkEl = selectors.link ? root.find(selectors.link).first() : root;
    const href = linkEl.attr('href');
    if (!href) return;

    const titleEl = selectors.title ? root.find(selectors.title).first() : linkEl;
    const title = (selectors.titleAttr ? titleEl.attr(selectors.titleAttr) : titleEl.text()) || '';
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    let dateText = null;
    if (selectors.date) {
      const dateEl = root.find(selectors.date).first();
      dateText = (selectors.dateAttr ? dateEl.attr(selectors.dateAttr) : dateEl.text()) || '';
      dateText = dateText.trim() || null;
    }

    let href2 = href;
    try {
      href2 = new URL(href, listUrl).toString();
    } catch {
      return;
    }

    items.push({
      title: trimmedTitle,
      link: href2,
      publishedAt: dateText ? parseTurkishDate(dateText) : null,
    });
  });

  return items;
}

async function scrapeHtmlList(source) {
  const res = await fetchWithTimeout(source.listUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return extractListItems(html, source.listUrl, source.selectors);
}

// Eczacı odalarının çoğu ortak birkaç web sitesi şablonundan birini
// kullanıyor. Bilinen şablonlardan biriyle eşleşirse (>=2 anlamlı öğe
// üretirse) o kaynak elle seçici yazmaya gerek kalmadan otomatik
// yapılandırılmış olur.
const TEMPLATE_LIBRARY = [
  {
    name: 'duzce-tarzi',
    selectors: { item: '.news article', link: 'a', title: 'a', titleAttr: 'title', date: 'h4 span' },
  },
  {
    name: 'aeo-tarzi',
    selectors: { item: '#sliderAreaAnnouncementsList li', link: 'a', title: 'a', titleAttr: 'title' },
  },
];

async function scrapeAutoTemplate(source) {
  const res = await fetchWithTimeout(source.homepage);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  for (const tpl of TEMPLATE_LIBRARY) {
    let items = [];
    try {
      items = extractListItems(html, source.homepage, tpl.selectors);
    } catch {
      continue;
    }
    if (items.length >= 2) {
      return { items, matchedTemplate: tpl.name };
    }
  }

  return { items: [], matchedTemplate: null };
}

async function scrapeSource(source) {
  const result = {
    id: source.id,
    name: source.name,
    category: source.category,
    homepage: source.homepage,
    status: 'ok',
    error: null,
    itemCount: 0,
    discoveredFeedUrl: null,
    matchedTemplate: null,
  };

  try {
    let items = [];

    if (source.type === 'rss' && source.feedUrl) {
      items = await scrapeRss(source.feedUrl);
    } else if (source.type === 'html' && source.listUrl && source.selectors) {
      items = await scrapeHtmlList(source);
    } else if (source.type === 'auto') {
      const feedUrl = await discoverFeedUrl(source.homepage);
      if (!feedUrl) {
        result.status = 'needs-config';
        result.error =
          'RSS beslemesi otomatik olarak bulunamadı. Bu kaynak için manuel CSS seçici yapılandırması gerekiyor (bkz. README).';
        return { result, items: [] };
      }
      result.discoveredFeedUrl = feedUrl;
      items = await scrapeRss(feedUrl);
    } else if (source.type === 'auto-template') {
      const feedUrl = await discoverFeedUrl(source.homepage);
      if (feedUrl) {
        result.discoveredFeedUrl = feedUrl;
        items = await scrapeRss(feedUrl);
      } else {
        const { items: tplItems, matchedTemplate } = await scrapeAutoTemplate(source);
        if (!matchedTemplate) {
          result.status = 'needs-config';
          result.error =
            'Ne RSS ne de bilinen bir site şablonu eşleşti. Bu kaynak için manuel CSS seçici yapılandırması gerekiyor (bkz. README).';
          return { result, items: [] };
        }
        result.matchedTemplate = matchedTemplate;
        items = tplItems;
      }
    } else {
      result.status = 'needs-config';
      result.error = 'Kaynak için geçerli bir tarama yöntemi tanımlı değil.';
      return { result, items: [] };
    }

    const normalized = items.slice(0, MAX_ITEMS_PER_SOURCE).map((it) => ({
      id: hashId(it.link),
      title: it.title,
      link: it.link,
      publishedAt: it.publishedAt,
      source: source.id,
      sourceName: source.name,
      category: source.category,
      fetchedAt: new Date().toISOString(),
    }));

    result.itemCount = normalized.length;
    if (normalized.length === 0) {
      result.status = 'empty';
      result.error = 'Kaynak yanıt verdi ancak ayrıştırılabilir haber bulunamadı.';
    }
    return { result, items: normalized };
  } catch (err) {
    result.status = 'error';
    const baseMsg = err && err.message ? err.message : String(err);
    const causeMsg = err && err.cause && err.cause.message;
    result.error = causeMsg ? `${baseMsg}: ${causeMsg}` : baseMsg;
    return { result, items: [] };
  }
}

async function loadPreviousData() {
  try {
    const raw = await readFile(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  const previous = await loadPreviousData();

  const sourceResults = [];
  let freshItems = [];

  for (const source of sources) {
    const { result, items } = await scrapeSource(source);
    sourceResults.push(result);
    freshItems = freshItems.concat(items);
    const suffix = result.error ? ` - ${result.error}` : '';
    console.log(`[${result.status.toUpperCase()}] ${source.name}: ${result.itemCount} öğe${suffix}`);
  }

  // Her habere, ilk keşfedildiği anı (firstSeenAt) KALICI olarak yazıyoruz.
  // Yeniden görülen haberde bu değer korunur; yalnızca yeni bulunanlar "şimdi"
  // damgası alır. Sıralama buna göre yapıldığından yeni haberler listenin
  // tepesine çıkar (tarihi olmayan kaynaklarda fetchedAt her tarama değiştiği
  // için sıralama donuyordu; firstSeenAt bunu çözer).
  const prevById = new Map((previous.items || []).map((it) => [it.id, it]));
  const merged = new Map();
  for (const it of previous.items || []) merged.set(it.id, { ...it, alsoFrom: undefined });
  for (const it of freshItems) {
    const prev = prevById.get(it.id);
    const firstSeenAt = (prev && prev.firstSeenAt) || it.fetchedAt;
    merged.set(it.id, { ...it, firstSeenAt });
  }
  for (const it of merged.values()) {
    if (!it.firstSeenAt) it.firstSeenAt = it.fetchedAt || it.publishedAt || null;
  }

  const sourcePriority = new Map(sources.map((s) => [s.id, s.priority ?? 99]));
  let allItems = dedupeItems(Array.from(merged.values()), sourcePriority);
  allItems.sort((a, b) => {
    const da = Date.parse(a.publishedAt || a.firstSeenAt || a.fetchedAt || 0);
    const db = Date.parse(b.publishedAt || b.firstSeenAt || b.fetchedAt || 0);
    return db - da;
  });
  allItems = allItems.slice(0, MAX_TOTAL_ITEMS);

  const output = {
    generatedAt: new Date().toISOString(),
    sources: sourceResults,
    items: allItems,
  };

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
  console.log(`\nToplam ${allItems.length} haber data/news.json dosyasına yazıldı.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
