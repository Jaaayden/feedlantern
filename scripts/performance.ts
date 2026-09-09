/** Local-only benchmark. PERF_SOURCE may point at an unpacked baseline checkout. */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TaskPool } from '../src/server/task-pool';
const source = resolve(process.env.PERF_SOURCE || '.');
const { BrowserService } = await import(pathToFileURL(join(source, 'src/server/browser.ts')).href);
const { Store } = await import(pathToFileURL(join(source, 'src/server/store.ts')).href);
const { getConfig } = await import(pathToFileURL(join(source, 'src/server/config.ts')).href);
const stages = new AsyncLocalStorage<Record<string, number>>();
function wrap(object: any, key: string, label: string) {
  const original = object[key];
  object[key] = async function(...args: any[]) {
    const start = performance.now();
    try { return await original.apply(this, args); }
    finally { const row = stages.getStore(); if (row) row[label] = (row[label] || 0) + performance.now() - start; }
  };
}
const cards = Array.from({ length: 12 }, (_, n) => `<article style="height:110px"><h2>测试文章 ${n} — FeedLantern performance</h2><a href="/item/${n}">Read ${n}</a><p>摘要 ${n}</p><time datetime="2026-01-01">2026-01-01</time></article>`).join('');
let screenPayload = '';
const server = createServer((req, res) => {
  if (req.url === '/screen') { res.setHeader('Content-Type','application/json'); res.end(screenPayload); return; }
  if (req.url === '/cookie' && !req.headers.cookie?.includes('test=ok')) { res.writeHead(401); res.end('login'); return; }
  const mode = req.url?.slice(1);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<title>Benchmark</title><style>body{margin:0;font:16px sans-serif}article{border-bottom:1px solid #abc}h2,p{margin:8px}#hero{height:${mode === 'long' ? 10000 : 0}px;background:linear-gradient(125deg,#134,#edb,#379)}</style><div id="hero"></div><main>${mode === 'dynamic' || mode === 'lazy' ? '' : cards}</main><script>
  ${mode === 'dynamic' ? `setTimeout(() => document.querySelector('main').innerHTML = ${JSON.stringify(cards)}, 200);` : ''}
  ${mode === 'lazy' ? `document.querySelector('main').style.marginTop='900px';document.querySelector('main').style.height='1800px';addEventListener('scroll',()=>{if(scrollY>100) setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(cards)},250)}, {once:true});` : ''}
  </script>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
const hosts = Array.from({length:4},()=>`127.0.0.1:${port}`);
const concurrency = Number(process.env.PERF_CONCURRENCY || 1);
const browser = new BrowserService({ allowedHosts: hosts, backgroundConcurrency: concurrency });
for (const [method,label] of [['ensureBrowser','browser-ready'],['createContext','context-inclusive'],['frame','screenshot-inclusive']]) wrap(browser, method, label);
const createContext = browser.createContext.bind(browser);
browser.createContext = async (...args: any[]) => {
  const context = await createContext(...args), createPage = context.newPage.bind(context);
  wrap(context, 'close', 'cleanup');
  context.newPage = async () => {
    const page = await createPage();
    for (const [key,label] of [['goto','navigation'],['waitForSelector','selector-wait'],['waitForTimeout','configured-wait'],['screenshot','image-encoding']]) wrap(page, key, label);
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (...args: any[]) => {
      const expression = String(args[0]);
      const label = expression.includes('stableBottom') ? 'pre-scroll' : 'dom-extraction';
      const started = performance.now();
      try { return await evaluate(...args); }
      finally { const row = stages.getStore(); if (row) row[label] = (row[label] || 0) + performance.now() - started; }
    };
    return page;
  };
  return context;
};
let peakRssMiB = 0, peakCpuPercent = 0;
function sample() {
  try {
    const rows = execFileSync('ps', ['-axo','pid=,ppid=,rss=,%cpu='], { encoding:'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const ids = new Set([process.pid]);
    for (let i=0;i<8;i++) for (const [pid,ppid] of rows) if (ids.has(ppid)) ids.add(pid);
    const own = rows.filter(row => ids.has(row[0]));
    peakRssMiB = Math.max(peakRssMiB, own.reduce((sum,row)=>sum+row[2],0)/1024);
    peakCpuPercent = Math.max(peakCpuPercent, own.reduce((sum,row)=>sum+row[3],0));
  } catch {}
}
const sampling = setInterval(sample, 200);
const dataDir = mkdtempSync(join(tmpdir(),'feedlantern-perf-'));
const store = new Store(getConfig({ dataDir }));
const rules = { item:'article',title:'h2',link:'a',description:'p',date:'time' };
const modes = ['static','dynamic','long','lazy','cookie'];
const rows: Array<Record<string, any>> = [];
const pool = new TaskPool(concurrency);
try {
  for (let repeat=0;repeat<3;repeat++) {
    const batchStarted = performance.now();
    await Promise.all(modes.map((mode,index) => {
      const url = `http://${hosts[index%hosts.length]}/${mode}`;
      const queued = performance.now();
      return pool.enqueue(async () => {
        const record: Record<string, any> = { mode,repeat,queue:performance.now()-queued };
        await stages.run(record, async () => {
          const start = performance.now();
          const items = await browser.scrape({ url,waitMs:300,rules,cookies:mode==='cookie' ? [{name:'test',value:'ok',domain:new URL(url).hostname,path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'}] : [] });
          record.capture = performance.now()-start;
          record.items = items;
          const feed = store.createFeed({name:mode,url,rules,intervalMinutes:60,waitMs:300,credentialId:null}).feed;
          const dbStart = performance.now(); store.upsertItems(feed,items); record.database = performance.now()-dbStart;
          record.total = performance.now()-start;
        }); rows.push(record);
      // Four logical sites share a loopback fixture transport; hostname locking
      // is tested separately in task-pool/API tests.
      }, [`fixture-site:${index%4}`]);
    }));
    rows.push({ batch:repeat,elapsed:performance.now()-batchStarted });
  }
  sample();
  const backgroundResources = { peakRssMiB, peakCpuPercent };
  const editor: Array<Record<string, any>> = [];
  const display = await (await browser.ensureBrowser()).newPage({viewport:{width:1280,height:800}});
  await display.goto(`http://${hosts[0]}/display`);
  for (let n=0;n<3;n++) {
    const record: Record<string, any> = {};
    await stages.run(record, async () => {
      const start = performance.now(); const frame = await browser.open({url:`http://${hosts[0]}/static`,waitMs:300});
      record.open = performance.now()-start;
      screenPayload = JSON.stringify(frame);
      record.display = await display.evaluate(`(async () => {
        const start=performance.now();
        const response=await fetch('/screen');
        const data=await response.json();
        const received=performance.now();
        const image=new Image(); image.src=data.image; await image.decode();
        document.body.replaceChildren(image);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {transferAndParse:received-start,decodeAndPaint:performance.now()-received,total:performance.now()-start};
      })()`);
      record.bytes = Buffer.byteLength(frame.image); record.type = frame.image.slice(0,22);
      const scroll = performance.now(); await browser.scroll(frame.sessionId,400); record.scroll = performance.now()-scroll;
      if (n===0) writeFileSync(join(process.env.PERF_OUTPUT_DIR || '/tmp',`feedlantern-${source===resolve('.')?'candidate':'baseline'}.${frame.image.includes('image/jpeg')?'jpg':'png'}`),Buffer.from(frame.image.split(',')[1],'base64'));
      await browser.close(frame.sessionId);
    }); editor.push(record);
  }
  await display.close();
  sample();
  console.log(JSON.stringify({source,concurrency,rows,editor,backgroundResources,peakRssMiB,peakCpuPercent,cpuSampling:'ps lifetime-average %CPU, sampled peak; not instantaneous utilization'},null,2));
} finally {
  clearInterval(sampling); await browser.dispose(); store.close(); server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(dataDir,{recursive:true,force:true});
}
