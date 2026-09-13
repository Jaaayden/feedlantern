import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 8766);

type FixtureState = {
  failure: boolean;
  version: number;
};

const state: FixtureState = { failure: false, version: 1 };

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
      sendJson(response, 200, { ...state });
    } catch {
      sendJson(response, 400, { error: 'invalid JSON' });
    }
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

  if (requestUrl.pathname === '/versioned' && state.failure) {
    sendHtml(response, 503, page('Fixture failure', '<p class="failure">Fixture failure requested by the test.</p>'));
    return;
  }

  if (requestUrl.pathname === '/static-scroll') {
    sendHtml(response, 200, staticPage().replace('</main>', '<div style="height:1600px">Scroll fixture spacer</div></main>'));
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

server.listen(port, host, () => {
  console.log(`FeedLantern fixture server listening on http://${host}:${port}`);
});

function close(): void {
  server.close(() => process.exit(0));
}

process.once('SIGTERM', close);
process.once('SIGINT', close);
