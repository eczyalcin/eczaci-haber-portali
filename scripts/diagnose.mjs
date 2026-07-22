// Kaynak tanılama betiği. config/sources.json içindeki her kaynağın ana
// sayfasını ham HTML olarak indirir, RSS/duyuru/haber ile ilgili linkleri
// çıkarır. Amaç: gerçek CSS seçicilerini/feed adreslerini elle yazabilmek
// için siteye ait gerçek yapıyı görmek (Actions ortamı tam internet
// erişimine sahip; geliştirme ortamı değil).
//
// Çıktı: diagnostics/<kaynak-id>.html (ham sayfa) + diagnostics/summary.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, '..');
const SOURCES_PATH = path.join(BASE_DIR, 'config', 'sources.json');
const OUT_DIR = path.join(BASE_DIR, 'diagnostics');
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; EczaciHaberMerkeziBot/1.0; +https://github.com/eczyalcin/dip-radar)';

const INTERESTING_KEYWORDS = ['rss', 'feed', 'atom', 'duyuru', 'haber', 'news'];

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
  } finally {
    clearTimeout(timer);
  }
}

function extractInterestingLinks($, baseUrl) {
  const links = new Map();
  $('a[href], link[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const lower = href.toLowerCase();
    if (!INTERESTING_KEYWORDS.some((kw) => lower.includes(kw))) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      const text = $(el).text().trim().slice(0, 80);
      if (!links.has(abs)) links.set(abs, text);
    } catch {
      // geçersiz URL, atla
    }
  });
  return Array.from(links.entries()).map(([href, text]) => ({ href, text }));
}

async function diagnoseUrl(outId, label, url) {
  const entry = {
    id: outId,
    name: label,
    homepage: url,
    httpStatus: null,
    contentLength: null,
    feedLinkTags: [],
    interestingLinks: [],
    error: null,
  };

  try {
    const res = await fetchWithTimeout(url);
    entry.httpStatus = res.status;
    if (!res.ok) {
      entry.error = `HTTP ${res.status}`;
      return entry;
    }
    const html = await res.text();
    entry.contentLength = html.length;

    const safeName = outId.replace(/[^a-z0-9-]/gi, '_');
    await writeFile(path.join(OUT_DIR, `${safeName}.html`), html, 'utf-8');

    const $ = cheerio.load(html);
    entry.feedLinkTags = $('link[type="application/rss+xml"], link[type="application/atom+xml"]')
      .map((_, el) => ({ href: $(el).attr('href'), title: $(el).attr('title') || null }))
      .get();
    entry.interestingLinks = extractInterestingLinks($, url).slice(0, 25);
  } catch (err) {
    entry.error = err && err.message ? err.message : String(err);
  }

  return entry;
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  await mkdir(OUT_DIR, { recursive: true });

  const results = [];
  for (const source of sources) {
    const entry = await diagnoseUrl(source.id, source.name, source.homepage);
    results.push(entry);
    console.log(
      `[${entry.error ? 'ERROR' : 'OK'}] ${source.name} (${source.homepage}) - HTTP ${entry.httpStatus} - ${entry.interestingLinks.length} ilgili link${entry.error ? ' - ' + entry.error : ''}`
    );

    let extraIndex = 0;
    for (const extraUrl of source.diagnoseUrls || []) {
      extraIndex += 1;
      const extraId = `${source.id}__extra${extraIndex}`;
      const extraEntry = await diagnoseUrl(extraId, `${source.name} (ek sayfa)`, extraUrl);
      results.push(extraEntry);
      console.log(
        `[${extraEntry.error ? 'ERROR' : 'OK'}]   ↳ ${extraUrl} - HTTP ${extraEntry.httpStatus} - ${extraEntry.interestingLinks.length} ilgili link${extraEntry.error ? ' - ' + extraEntry.error : ''}`
      );
    }
  }

  await writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2) + '\n', 'utf-8');
  console.log(`\nTanılama tamamlandı. Çıktı: diagnostics/`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
