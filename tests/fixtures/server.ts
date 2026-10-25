import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';

/** Recorded NCBI E-utilities answers and a PubMed-style bot check (tests/fixtures/pubmed). */
const pubmedFixture = (name: string) => readFileSync(new URL(`./pubmed/${name}`, import.meta.url), 'utf8');
const pubmedSearches: string[] = [];

const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 8766);

type FixtureState = {
  failure: boolean;
  version: number;
  /** /redesign: false serves the original list, true a redesigned page where the old rules match only two leftovers. */
  redesigned: boolean;
  /** /optional-fields: the six articles stay unchanged, only their date selector moves. */
  movedDate: boolean;
  absentDate: boolean;
};

const state: FixtureState = { failure: false, version: 1, redesigned: false, movedDate: false, absentDate: false };

type Article = {
  title: string;
  slug: string;
  description: string;
  image: string;
  date: string;
};

const staticArticles: Article[] = [
  {
    title: 'Fixture article one',
    slug: 'one',
    description: 'The first deterministic fixture article.',
    image: '/assets/fixture-one.svg',
    date: '2026-01-03T10:00:00.000Z',
  },
  {
    title: 'Fixture article two',
    slug: 'two',
    description: 'The second deterministic fixture article.',
    image: '/assets/fixture-two.svg',
    date: '2026-01-02T10:00:00.000Z',
  },
  {
    title: 'Fixture article three',
    slug: 'three',
    description: 'The third deterministic fixture article.',
    image: '/assets/fixture-three.svg',
    date: '2026-01-01T10:00:00.000Z',
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function articleCard(article: Article, prefix = ''): string {
  const href = `/article/${prefix}${article.slug}`;
  return `
    <article class="article-card" data-fixture-item="true">
      <a class="article-link" href="${href}">
        <img class="article-image" src="${article.image}" alt="${escapeHtml(article.title)} image" width="160" height="90" />
        <span class="article-title">${escapeHtml(article.title)}</span>
      </a>
      <p class="article-summary">${escapeHtml(article.description)}</p>
      <time class="article-date" datetime="${article.date}">${article.date.slice(0, 10)}</time>
    </article>`;
}

function page(title: string, body: string, script = ''): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; color: #15202b; }
        main { max-width: 60rem; margin: 0 auto; }
        .article-list { display: grid; gap: 1rem; }
        .article-card { border: 1px solid #cad3dc; border-radius: .5rem; padding: 1rem; background: #fff; }
        .article-link { display: grid; grid-template-columns: 10rem 1fr; gap: 1rem; align-items: center; color: inherit; text-decoration: none; }
        .article-title { font-weight: 700; font-size: 1.15rem; }
        .article-summary { margin: .75rem 0 .25rem; }
        .article-date { color: #5b6875; font-size: .9rem; }
        nav { display: flex; gap: .75rem; margin-bottom: 1rem; }
        nav a { color: #1e5fa5; }
        .locked, .failure { padding: 1rem; border: 1px solid #d08c8c; background: #fff3f3; }
      </style>
    </head>
    <body><main>${body}</main><script>${script}</script></body>
  </html>`;
}

function staticPage(): string {
  return page(
    'Fixture static cards',
    `<h1>Fixture static cards</h1>
      <p data-fixture-description="static">A stable page with all RSS fields.</p>
      <section class="article-list" data-fixture-list="static">
        ${staticArticles.map((article) => articleCard(article)).join('')}
      </section>`,
  );
}

function divCardPage(): string {
  return page(
    'Fixture div cards',
    `<h1>Fixture div cards</h1>
      <div id="div-card-list">
        ${staticArticles.map((article) => `
          <div class="card" data-card="${article.slug}">
            <a class="card-link" href="/div/${article.slug}"><strong class="card-heading">${escapeHtml(article.title)}</strong></a>
            <div class="card-copy">${escapeHtml(article.description)}</div>
            <img class="card-picture" data-src="${article.image}" alt="${escapeHtml(article.title)}" />
            <span class="card-time">${article.date}</span>
          </div>`).join('')}
      </div>`,
  );
}

function dynamicPage(): string {
  const cards = staticArticles.map((article) => articleCard(article, 'dynamic-')).join('');
  return page(
    'Fixture dynamic cards',
    `<h1>Fixture dynamic cards</h1>
      <p id="dynamic-status">Loading fixture content…</p>
      <section id="dynamic-list" class="article-list" data-fixture-list="dynamic"></section>`,
    `setTimeout(() => {
      document.querySelector('#dynamic-list').innerHTML = ${JSON.stringify(cards)};
      document.querySelector('#dynamic-status').textContent = 'Loaded';
      document.body.dataset.fixtureLoaded = 'true';
    }, 120);`,
  );
}

function cookieGatedPage(hasCookie: boolean): string {
  if (!hasCookie) {
    return page(
      'Fixture cookie gated',
      `<h1>Fixture cookie gated</h1><p class="locked" data-testid="cookie-locked">This fixture requires its test cookie.</p>`,
    );
  }
  return page(
    'Fixture cookie gated',
    `<h1>Fixture cookie gated</h1>
      <p data-testid="cookie-unlocked">The fixture cookie was accepted.</p>
      <section class="article-list" data-fixture-list="cookie">
        ${staticArticles.map((article) => articleCard({ ...article, slug: `cookie-${article.slug}` })).join('')}
      </section>`,
  );
}

function ambiguousPage(): string {
  const list = (prefix: string) => staticArticles.map((article) => articleCard(article, prefix)).join('');
  return page(
    'Fixture ambiguous lists',
    `<h1>Fixture ambiguous lists</h1>
      <nav aria-label="Fixture navigation">
        <a href="/nav/home">Home</a><a href="/nav/archive">Archive</a><a href="/nav/about">About</a>
      </nav>
      <section aria-labelledby="first-heading" class="article-list primary-list" data-fixture-list="first">
        <h2 id="first-heading">First equally good list</h2>${list('first-')}
      </section>
      <section aria-labelledby="second-heading" class="article-list secondary-list" data-fixture-list="second">
        <h2 id="second-heading">Second equally good list</h2>${list('second-')}
      </section>`,
  );
}

function versionedPage(): string {
  const articles = state.version === 1
    ? staticArticles
    : staticArticles.map((article) => ({
        ...article,
        title: `Updated ${article.title}`,
        slug: `updated-${article.slug}`,
      }));
  return page(
    `Fixture version ${state.version}`,
    `<h1>Fixture version ${state.version}</h1>
      <section class="article-list" data-fixture-list="versioned">
        ${articles.map((article) => articleCard(article, `v${state.version}-`)).join('')}
      </section>`,
  );
}

function optionalFieldsPage(): string {
  let cards = Array.from({ length: 6 }, (_, i) => articleCard({
    title: `Optional fields story ${i + 1}`, slug: `optional-${i + 1}`,
    description: `Summary of optional fields story ${i + 1}.`, image: '/assets/fixture-one.svg',
    date: `2026-02-${String(10 - i).padStart(2, '0')}T08:00:00.000Z`,
  }, 'optional-')).join('');
  if (state.absentDate) cards = cards.replaceAll(/<time\b[^>]*>[^<]*<\/time>/g, '');
  return page('Optional fields fixture', `<h1>Optional fields fixture</h1><section class="article-list">${state.movedDate ? cards.replaceAll('class="article-date"', 'class="release-date"') : cards}</section>`);
}

function redesignPage(): string {
  const articles = Array.from({ length: 10 }, (_, i) => ({
    title: `Redesign fixture story ${i + 1}`,
    slug: `story-${i + 1}`,
    description: `Summary of redesign fixture story ${i + 1}.`,
    image: '/assets/fixture-one.svg',
    date: `2026-02-${String(10 - i).padStart(2, '0')}T08:00:00.000Z`,
  }));
  if (!state.redesigned) {
    return page('Redesign fixture', `<h1>Redesign fixture</h1>
      <section class="article-list" data-fixture-list="redesign">${articles.map(article => articleCard(article, 'redesign-')).join('')}</section>`);
  }
  // After a redesign the list moved to new markup; two old-style promos remain.
  return page('Redesign fixture', `<h1>Redesign fixture</h1>
    <aside class="article-list" data-fixture-list="leftovers">${articles.slice(0, 2).map(article => articleCard({ ...article, title: `Promo ${article.title}`, slug: `promo-${article.slug}` }, 'redesign-')).join('')}</aside>
    <ul class="story-list" data-fixture-list="stories">${articles.map(article => `
      <li class="story">
        <h3 class="story-headline"><a href="/article/new-${article.slug}">${escapeHtml(article.title)}</a></h3>
        <p class="story-dek">${escapeHtml(article.description)}</p>
        <time class="story-date" datetime="${article.date}">${article.date.slice(0, 10)}</time>
      </li>`).join('')}
    </ul>`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);

  if (requestUrl.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === '/__control') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST required' });
      return;
    }
    try {
      const payload = JSON.parse(await readBody(request)) as Partial<FixtureState>;
      if (typeof payload.failure === 'boolean') state.failure = payload.failure;
      if (typeof payload.version === 'number' && Number.isInteger(payload.version)) state.version = payload.version;
      if (typeof payload.redesigned === 'boolean') state.redesigned = payload.redesigned;
      if (typeof payload.movedDate === 'boolean') state.movedDate = payload.movedDate;
      if (typeof payload.absentDate === 'boolean') state.absentDate = payload.absentDate;
      sendJson(response, 200, { ...state });
    } catch {
      sendJson(response, 400, { error: 'invalid JSON' });
    }
    return;
  }

  // Local stand-ins for DeepL and OpenAI-compatible translation APIs.
  if (request.method === 'POST' && /^\/deepl\/(free|pro)\/v2\/translate$/.test(requestUrl.pathname)) {
    const body = JSON.parse(await readBody(request)) as { text: string[]; target_lang: string };
    if (!String(request.headers.authorization ?? '').startsWith('DeepL-Auth-Key ')) { sendJson(response, 403, { message: 'Forbidden' }); return; }
    sendJson(response, 200, { translations: body.text.map(text => ({ detected_source_language: 'EN', text: `DeepL ${body.target_lang}：${text.trim()}` })) });
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/openai/v1/chat/completions') {
    const body = JSON.parse(await readBody(request)) as { model: string; messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(message => message.role === 'user')?.content ?? '';
    const language = body.messages[0]?.content.match(/into ([A-Za-z ]+)\./)?.[1] ?? '?';
    const content = [...user.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)].map(match => `<seg id="${match[1]}">${language} ${body.model}：${match[2].trim()}</seg>`).join('\n');
    sendJson(response, 200, { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    return;
  }

  if (requestUrl.pathname === '/assets/fixture-one.svg' || requestUrl.pathname === '/assets/fixture-two.svg' || requestUrl.pathname === '/assets/fixture-three.svg') {
    const label = requestUrl.pathname.includes('one') ? 'one' : requestUrl.pathname.includes('two') ? 'two' : 'three';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="#d9e6f2"/><text x="80" y="48" text-anchor="middle" fill="#25405a">${label}</text></svg>`;
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': Buffer.byteLength(svg) });
    response.end(svg);
    return;
  }

  if (requestUrl.pathname === '/redirect-malicious') {
    response.writeHead(302, { location: 'http://127.0.0.1:8767/fixture-secret' });
    response.end();
    return;
  }

  if (requestUrl.pathname === '/redesign') {
    sendHtml(response, 200, redesignPage());
    return;
  }

  if (requestUrl.pathname === '/optional-fields') {
    sendHtml(response, 200, optionalFieldsPage());
    return;
  }

  if (requestUrl.pathname === '/versioned' && state.failure) {
    sendHtml(response, 503, page('Fixture failure', '<p class="failure">Fixture failure requested by the test.</p>'));
    return;
  }

  if (requestUrl.pathname === '/very-long') {
    // The list starts below the first 8000px screenshot segment.
    sendHtml(response, 200, staticPage().replace('<h1>Fixture static cards</h1>', '<h1>Fixture static cards</h1><div style="height:14000px">Long page spacer</div>'));
    return;
  }
  if (requestUrl.pathname === '/hub') {
    sendHtml(response, 200, page('Fixture hub', '<main><h1>Fixture hub</h1><p><a class="hub-link" href="/div-cards" style="display:inline-block;padding:12px 24px">Open the card list</a></p></main>'));
    return;
  }
  if (requestUrl.pathname === '/static-scroll') {
    sendHtml(response, 200, staticPage().replace('</main>', '<div style="height:1600px">Scroll fixture spacer</div></main>'));
    return;
  }
  if (/^\/assets\/cover-[1-3]\.svg$/.test(requestUrl.pathname)) {
    const hue = [148, 38, 200][Number(requestUrl.pathname.match(/(\d)\.svg$/)![1]) - 1];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 62%)"/><stop offset="1" stop-color="hsl(${hue + 40} 50% 32%)"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="236" cy="78" r="34" fill="hsl(${hue} 80% 88%)" opacity=".8"/><path d="M0 190 L90 120 L160 170 L230 110 L320 180 V240 H0Z" fill="hsl(${hue + 20} 40% 22%)" opacity=".7"/></svg>`;
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': Buffer.byteLength(svg) });
    response.end(svg);
    return;
  }
  // A small reader-style feed: images, long and short bodies, and a bilingual-friendly structure.
  if (requestUrl.pathname === '/reader.xml') {
    const origin = `http://${host}:${port}`;
    const item = (id: string, title: string, html: string, date: string) => `<item><guid>${id}</guid><title>${title}</title><link>${origin}/article/${id}</link><description><![CDATA[${html}]]></description><pubDate>${date}</pubDate></item>`;
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    response.end(`<rss version="2.0"><channel><title>Lantern Reader fixture</title>${[
      item('reader-1', 'Night trains are back across Europe', `<p><img src="${origin}/assets/cover-1.svg" alt="Train at dusk"></p><p>Sleeper services that disappeared a decade ago are returning, as operators bet that travellers will trade a short flight for a quiet cabin and an early arrival downtown.</p><p>The new routes connect twelve cities and run three times a week through the winter season.</p><blockquote>Rail is the slow lane that gets you there rested.</blockquote><p>Bookings opened on Monday and the first departures sold out within hours.</p>`, 'Thu, 22 Oct 2026 20:00:00 GMT'),
      item('reader-2', 'A field guide to reading less, but better', '<p>Short notes on keeping a calm reading list.</p>', 'Thu, 22 Oct 2026 08:30:00 GMT'),
      item('reader-3', 'Unstable connection report', '<p>Measurements from a week of flaky home internet, with charts and a short list of fixes that actually helped.</p><ul><li>Move the router</li><li>Change the channel</li></ul>', 'Tue, 20 Oct 2026 12:00:00 GMT'),
      item('reader-4', 'Designing a lantern you can read by', `<p><img src="${origin}/assets/cover-2.svg" alt="Lantern"></p><p>Warm light, soft shadows and a glass that does not glare: the small decisions behind a lamp made for long evenings with a book.</p><pre>lumens = 180</pre>`, 'Mon, 12 Oct 2026 09:00:00 GMT'),
    ].join('')}</channel></rss>`);
    return;
  }
  // Stand-in for eutils.ncbi.nlm.nih.gov; the e2e backend sends every PubMed search here.
  // A term containing "zzqx" matches nothing; every other search lists the same three articles.
  if (requestUrl.pathname === '/entrez/eutils/esearch.fcgi') {
    pubmedSearches.push(requestUrl.searchParams.get('term') ?? '');
    // Like NCBI: the limit header says 10 with an API key, 3 without.
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-RateLimit-Limit': requestUrl.searchParams.get('api_key') ? '10' : '3' });
    response.end(pubmedFixture((requestUrl.searchParams.get('term') ?? '').includes('zzqx') ? 'esearch-empty.json' : 'esearch-journal.json'));
    return;
  }
  // PubMed search RSS feeds for the conversion check: the channel title is the query.
  const pubmedRss = /^\/pubmed-rss\/rss\/search\/(\w+)\/?$/.exec(requestUrl.pathname);
  if (pubmedRss) {
    const feeds: Record<string, [string, string[]]> = {
      e2eok: ['("PLoS Pathog"[Journal]) AND (Wolbachia[tiab])', ['42883926', '41714066']],
      e2elow: ['(lantern[ti]) AND (fungi[ti]', ['40000001', '40000002']],
    };
    const entry = feeds[pubmedRss[1]];
    if (!entry) { response.writeHead(404); response.end(); return; }
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    response.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escape(entry[0])}</title><description>${escape(entry[0])}: Latest results from PubMed</description>${entry[1].map(pmid => `<item><title>Article ${pmid}</title><link>https://pubmed.ncbi.nlm.nih.gov/${pmid}/?utm_source=Other</link><guid isPermaLink="false">pubmed:${pmid}</guid><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`);
    return;
  }
  // The terms esearch received, for tests that check what reached NCBI.
  if (requestUrl.pathname === '/entrez/searches') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pubmedSearches));
    return;
  }
  if (requestUrl.pathname === '/entrez/eutils/efetch.fcgi') {
    response.writeHead(200, { 'Content-Type': 'text/xml' });
    response.end(pubmedFixture('efetch-journal.xml'));
    return;
  }
  // What PubMed's RSS addresses now answer programs with: HTTP 203 and a proof-of-work page.
  if (requestUrl.pathname === '/challenge-feed.xml') {
    response.writeHead(203, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(pubmedFixture('journal-challenge.html'));
    return;
  }
  if (requestUrl.pathname === '/feed.xml') {
    if (request.headers['if-none-match'] === 'rss-fixture-v1') { response.writeHead(304); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: 'rss-fixture-v1' });
    response.end(`<rss version="2.0"><channel><title>RSS translation fixture</title><item><guid>rss-one</guid><title>Hello RSS</title><link>http://${host}:${port}/article/one</link><description><![CDATA[<p>This is an English article with <strong>bold text</strong>.</p><ul><li>One item</li></ul><pre>const example = 1;</pre>]]></description><pubDate>Sat, 12 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`);
    return;
  }
  if (requestUrl.pathname === '/static') {
    sendHtml(response, 200, staticPage());
    return;
  }
  if (requestUrl.pathname === '/div-cards') {
    sendHtml(response, 200, divCardPage());
    return;
  }
  if (requestUrl.pathname === '/dynamic') {
    sendHtml(response, 200, dynamicPage());
    return;
  }
  if (requestUrl.pathname === '/cookie-gated') {
    const cookie = request.headers.cookie ?? '';
    sendHtml(response, 200, cookie.includes('fl-auth=fixture-secret') ? cookieGatedPage(true) : cookieGatedPage(false));
    return;
  }
  if (requestUrl.pathname === '/relative-dates') {
    sendHtml(response, 200, `<!doctype html><meta charset="utf-8"><title>Relative dates</title>
      <style>body{margin:0;font:16px sans-serif}.frow{display:block;height:90px}.fttl,.fmeta{display:block;height:30px}</style>
      ${[1, 2, 3].map(n => `<a class="frow" href="/article/relative-${n}"><span class="fttl">相对时间文章 ${n}</span><span class="fmeta"><span>猎奇</span><span>NodeSeek</span> · 3分前</span></a>`).join('')}`);
    return;
  }
  if (requestUrl.pathname === '/generate_204') {
    // A local stand-in for the connectivity check URL the network test defaults to.
    response.writeHead(204);
    response.end();
    return;
  }
  if (requestUrl.pathname === '/network/list') {
    // Echoes the request headers a network profile sets, so a feed shows them.
    const ua = escapeHtml(String(request.headers['user-agent'] ?? ''));
    const token = escapeHtml(String(request.headers['x-e2e-token'] ?? 'none'));
    const referer = escapeHtml(String(request.headers.referer ?? 'none'));
    sendHtml(response, 200, page('Network fixture', `<main>${[1, 2, 3].map(n => `<article class="net-card"><a class="net-link" href="/article/net-${n}"><h2 class="net-title">Network ${n} ua=${ua} token=${token} referer=${referer}</h2></a></article>`).join('')}</main>`));
    return;
  }
  if (requestUrl.pathname === '/proxy-log') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(proxyLog));
    return;
  }
  if (requestUrl.pathname === '/paged' || requestUrl.pathname === '/paged-internal') {
    // Three list pages linked by rel="next"; the internal variant links page 2 to a private address.
    const number = Math.min(3, Math.max(1, Number(requestUrl.searchParams.get('page') ?? 1) || 1));
    const internal = requestUrl.pathname === '/paged-internal';
    const articles = staticArticles.map((article, index) => ({ ...article, title: `Paged ${number}-${index + 1}`, slug: `paged-${number}-${index + 1}` }));
    const next = internal ? 'http://10.255.255.1/internal-next' : number < 3 ? `/paged?page=${number + 1}` : '';
    sendHtml(response, 200, page(`Fixture paged list ${number}`, `<h1>Fixture paged list ${number}</h1>
      <section class="article-list" data-fixture-list="paged">${articles.map((article) => articleCard(article)).join('')}</section>
      ${next ? `<nav aria-label="Pagination"><a class="next-page" rel="next" href="${next}">Next page</a></nav>` : ''}`));
    return;
  }
  if (requestUrl.pathname === '/ambiguous') {
    sendHtml(response, 200, ambiguousPage());
    return;
  }
  if (requestUrl.pathname === '/versioned') {
    sendHtml(response, 200, versionedPage());
    return;
  }

  sendHtml(response, 404, page('Fixture not found', '<p>Not found</p>'));
});

// The fixture is also an authenticated HTTP CONNECT proxy for network profile
// tests. It only tunnels to itself, never to another host.
const proxyLog: Array<{ target: string; authorized: boolean }> = [];
const proxyAuth = `Basic ${Buffer.from('e2e-proxy-user:e2e-proxy-pass').toString('base64')}`;
server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
  const authorized = request.headers['proxy-authorization'] === proxyAuth;
  proxyLog.push({ target: request.url ?? '', authorized });
  client.on('error', () => client.destroy());
  if (!authorized) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n'); return; }
  if (request.url !== `${host}:${port}`) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  const upstream = netConnect(port, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
});

server.listen(port, host, () => {
  console.log(`FeedLantern fixture server listening on http://${host}:${port}`);
});

function close(): void {
  server.close(() => process.exit(0));
}

process.once('SIGTERM', close);
process.once('SIGINT', close);
