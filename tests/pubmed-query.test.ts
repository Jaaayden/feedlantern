import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPubmedQuery, parsePubmedQuery, pubmedConversion, pubmedTermHasOperator, pubmedDefaultName, pubmedQueryProblem, pubmedRssSource, pubmedSearchFromUrl, pubmedSearchUrl, pubmedTerm,
  PUBMED_FIELD_IDS, type PubmedBuilder,
} from '../src/shared/pubmed.js';

const rows = (...list: Array<[PubmedBuilder['rows'][number]['op'], PubmedBuilder['rows'][number]['field'], string]>) => list.map(([op, field, term]) => ({ op, field, term }));

test('查询式生成：与 PubMed 高级检索构建器相同，写成 (检索词[字段])，默认不加引号也不改写检索词', () => {
  assert.equal(buildPubmedQuery({ rows: rows(['AND', 'tiab', 'cryo-EM'], ['AND', 'affiliation', 'ShanghaiTech']), filters: {} }), '(cryo-EM[Title/Abstract]) AND (ShanghaiTech[Affiliation])');
  // A user's PubMed search RSS title is reproduced exactly (automatic term mapping still applies).
  const title = '(Hu wanlong[Author]) AND (The University of Hong Kong[Affiliation])';
  assert.equal(buildPubmedQuery(parsePubmedQuery(title)!), title);
  // Three or more lines nest from the left, as PubMed's Advanced Search Builder writes them.
  assert.equal(buildPubmedQuery({ rows: rows(['AND', 'author', 'Sun Jin-peng'], ['OR', 'firstAuthor', 'Li X'], ['NOT', 'lastAuthor', 'Wang Z']), filters: {} }), '((Sun Jin-peng[Author]) OR (Li X[Author - First])) NOT (Wang Z[Author - Last])');
  // All Fields has no tag, like PubMed's builder; case is kept (PubMed ignores it).
  assert.deepEqual(PUBMED_FIELD_IDS.map(field => pubmedTerm(field, 'x')), ['x', 'x[Title/Abstract]', 'x[Title]', 'x[Author]', 'x[Author - First]', 'x[Author - Last]', 'x[Journal]', 'x[Affiliation]', 'x[MeSH Terms]', 'x[Publication Type]', 'x[Language]', 'x[jid]']);
  assert.equal(pubmedTerm('all', 'cryo electron microscopy'), 'cryo electron microscopy');
  // Only "Exact phrase", or quotes the user typed, add quotes (turning automatic term mapping off).
  assert.equal(pubmedTerm('all', 'cryo electron microscopy', true), '"cryo electron microscopy"');
  assert.equal(pubmedTerm('author', '"Sun Jin-peng"'), '"Sun Jin-peng"[Author]');
  assert.deepEqual(parsePubmedQuery('("cryo electron microscopy") AND (Sun Jin-peng[Author])')!.rows, [{ op: 'AND', field: 'all', term: 'cryo electron microscopy', phrase: true }, { op: 'AND', field: 'author', term: 'Sun Jin-peng' }]);
  assert.equal(buildPubmedQuery({ rows: [{ op: 'AND', field: 'title', term: 'stem cell', phrase: true }, { op: 'NOT', field: 'all', term: 'mouse' }], filters: {} }), '("stem cell"[Title]) NOT (mouse)');
  // Empty lines are skipped; a single line is just that line.
  assert.equal(buildPubmedQuery({ rows: rows(['AND', 'journal', 'PLoS Pathog'], ['AND', 'tiab', '   ']), filters: {} }), '(PLoS Pathog[Journal])');
  assert.equal(buildPubmedQuery({ rows: [], filters: {} }), '');
});

test('检索词只处理会破坏语法的字符：方括号、未配平的括号和引号；大写运算符给出提示', () => {
  assert.equal(pubmedTerm('title', 'a[b]c'), 'a b c[Title]');
  assert.equal(pubmedTerm('title', 'a (b'), 'a b[Title]');
  assert.equal(pubmedTerm('title', 'a) b (c'), 'a b c[Title]');
  assert.equal(pubmedTerm('title', 'IL-6 (interleukin)'), 'IL-6 (interleukin)[Title]');
  assert.equal(pubmedTerm('title', 'x "y'), 'x y[Title]');
  assert.equal(pubmedTerm('title', 'say "hello" (world)', true), '"say hello (world)"[Title]');
  assert.equal(pubmedTerm('author', '  Smith\u0000 J\n'), 'Smith J[Author]');
  assert.equal(pubmedTerm('affiliation', '"'), '');
  // Upper-case operators are left alone (PubMed reads them as operators) and pointed out.
  assert.equal(pubmedTerm('title', 'cats AND dogs'), 'cats AND dogs[Title]');
  assert.equal(pubmedTermHasOperator('cats AND dogs'), true);
  assert.equal(pubmedTermHasOperator('cats and dogs'), false);
  assert.equal(pubmedTermHasOperator('cats AND dogs', true), false);
  assert.equal(pubmedTermHasOperator('ANDROGEN'), false);
  // Whatever is typed, the query stays well-formed and reads back to the same query.
  for (const raw of ['a"b', '((', ')) OR ((', '[Title]', 'x" OR "y', '"', '\\"', 'a]b', '* : /', 'cats AND dogs']) {
    for (const field of ['all', 'title', 'affiliation'] as const) for (const phrase of [false, true]) {
      const query = buildPubmedQuery({ rows: [{ op: 'AND', field, term: raw, phrase }, { op: 'AND', field: 'journal', term: 'Nature' }], filters: {} });
      assert.equal(pubmedQueryProblem(query), null, `${field} ${raw}: ${query}`);
      const back = parsePubmedQuery(query);
      // Read back into the builder, the query is stable from then on.
      if (back) { const again = buildPubmedQuery(back); assert.equal(pubmedQueryProblem(again), null); assert.equal(buildPubmedQuery(parsePubmedQuery(again)!), again, `${field} ${raw}: ${query}`); }
    }
  }
});

test('筛选：最近 N 天、日期区间、只看有摘要、文章类型写在最后，并能原样读回', () => {
  const builder: PubmedBuilder = { rows: rows(['AND', 'all', 'cancer'], ['OR', 'mesh', 'Neoplasms']), filters: { days: 30, hasAbstract: true, types: ['Review', 'Clinical Trial'] } };
  const query = buildPubmedQuery(builder);
  assert.equal(query, '((cancer) OR (Neoplasms[MeSH Terms])) AND ("last 30 days"[Date - Publication]) AND (hasabstract) AND ("Review"[pt] OR "Clinical Trial"[pt])');
  assert.deepEqual(parsePubmedQuery(query), builder);
  assert.equal(buildPubmedQuery({ rows: rows(['AND', 'journal', 'Nature']), filters: { from: '2020/01/01' } }), '(Nature[Journal]) AND (2020/01/01:3000[Date - Publication])');
  assert.equal(buildPubmedQuery({ rows: [], filters: { to: '2021', hasAbstract: true } }), '(1800:2021[Date - Publication]) AND (hasabstract)');
  for (const filters of [{ from: '2020/01/01' }, { to: '2021/06' }, { from: '2019', to: '2020/12/31' }, { types: ['Meta-Analysis' as const] }, { hasAbstract: true }]) {
    const built = { rows: rows(['AND', 'title', 'sepsis']), filters };
    assert.deepEqual(parsePubmedQuery(buildPubmedQuery(built)), built);
  }
  // A Publication Type line stays a line; only the [pt] shortcut at the end is a filter.
  const line = { rows: rows(['AND', 'title', 'sepsis'], ['AND', 'pubType', 'Review']), filters: {} };
  assert.deepEqual(parsePubmedQuery(buildPubmedQuery(line)), line);
});

test('手写查询式读回构建器：常见写法能还原，构建器表达不了的改为手动编辑', () => {
  assert.deepEqual(parsePubmedQuery('cancer'), { rows: rows(['AND', 'all', 'cancer']), filters: {} });
  assert.deepEqual(parsePubmedQuery('heart attack[tiab] AND smith j[au]'), { rows: rows(['AND', 'tiab', 'heart attack'], ['AND', 'author', 'smith j']), filters: {} });
  assert.deepEqual(parsePubmedQuery('"PLoS Pathog"[jour] AND "last 7 days"[dp]'), { rows: [{ op: 'AND', field: 'journal', term: 'PLoS Pathog', phrase: true }], filters: { days: 7 } });
  assert.deepEqual(parsePubmedQuery('(a OR b) AND c'), { rows: rows(['AND', 'all', 'a'], ['OR', 'all', 'b'], ['AND', 'all', 'c']), filters: {} });
  assert.deepEqual(parsePubmedQuery('a AND (b AND c)'), { rows: rows(['AND', 'all', 'a'], ['AND', 'all', 'b'], ['AND', 'all', 'c']), filters: {} });
  assert.deepEqual(parsePubmedQuery('"x" [tiab] review[pt]'), { rows: [{ op: 'AND', field: 'tiab', term: 'x', phrase: true }], filters: { types: ['Review'] } });
  assert.deepEqual(parsePubmedQuery('101238921[jid]'), { rows: rows(['AND', 'nlmId', '101238921']), filters: {} });
  // Grouping on the right, unknown fields and filters in the middle cannot be builder lines.
  for (const manual of ['a AND (b OR c)', 'a NOT (b NOT c)', 'cancer[dp]', 'x[Grants and Funding]', '"last 30 days"[dp] OR x']) {
    assert.equal(pubmedQueryProblem(manual), null, manual);
    assert.equal(parsePubmedQuery(manual), null, manual);
  }
});

test('查询式检查：引号、括号、标签、运算符和长度', () => {
  assert.equal(pubmedQueryProblem('  '), 'empty');
  assert.equal(pubmedQueryProblem('"cancer'), 'unbalancedQuotes');
  assert.equal(pubmedQueryProblem('(cancer'), 'unbalancedParentheses');
  assert.equal(pubmedQueryProblem('cancer)'), 'unbalancedParentheses');
  assert.equal(pubmedQueryProblem('cancer[ti'), 'unclosedTag');
  assert.equal(pubmedQueryProblem('cancer AND'), 'danglingOperator');
  assert.equal(pubmedQueryProblem('NOT cancer'), 'danglingOperator');
  assert.equal(pubmedQueryProblem('(a AND) b'), 'danglingOperator');
  assert.equal(pubmedQueryProblem('a AND ()'), 'emptyGroup');
  assert.equal(pubmedQueryProblem('x'.repeat(4001)), 'tooLong');
  assert.equal(pubmedQueryProblem('"heart attack"[tiab:~2] AND 2020:2024[dp]'), null);
});

test('PubMed 地址：检索订阅保存为 PubMed 检索页；识别期刊 RSS 和检索式 RSS 并给出转换预填', () => {
  const url = pubmedSearchUrl({ query: '("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])', limit: 50 });
  assert.equal(url, 'https://pubmed.ncbi.nlm.nih.gov/?term=%28%22cryo-EM%22%5BTitle%2FAbstract%5D%29+AND+%28%22ShanghaiTech%22%5BAffiliation%5D%29&sort=date&size=50');
  assert.deepEqual(pubmedSearchFromUrl(url), { query: '("cryo-EM"[Title/Abstract]) AND ("ShanghaiTech"[Affiliation])', limit: 50 });
  assert.deepEqual(pubmedSearchFromUrl('https://pubmed.ncbi.nlm.nih.gov/?term=cancer&size=7'), { query: 'cancer', limit: 20 });
  for (const other of ['https://pubmed.ncbi.nlm.nih.gov/?term=', 'https://example.com/?term=x', 'https://pubmed.ncbi.nlm.nih.gov/123/?term=x', 'https://u:p@pubmed.ncbi.nlm.nih.gov/?term=x', 'nope']) assert.equal(pubmedSearchFromUrl(other), null, other);

  const journal = pubmedRssSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/?limit=15&name=PLoS%20Pathog&utm_campaign=journals');
  assert.deepEqual(journal, { kind: 'journal', nlmId: '101238921', limit: 15, name: 'PLoS Pathog' });
  assert.deepEqual(pubmedRssSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/0372516r?limit=500'), { kind: 'journal', nlmId: '0372516R', limit: 100 });
  assert.deepEqual(pubmedRssSource('https://pubmed.ncbi.nlm.nih.gov/rss/search/1PW-O5V9EIr5_xQhKq/?limit=20&utm_campaign=pubmed-2'), { kind: 'search', id: '1PW-O5V9EIr5_xQhKq', limit: 20 });
  for (const other of ['https://example.com/rss/journals/101238921/', 'https://user:pw@pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/', 'not a url']) assert.equal(pubmedRssSource(other), null, other);

  // The journal RSS `name` is the ISO abbreviation PubMed's Journal field matches
  // (NCBI itself turns 101238921[jid] into "plos pathog"[Journal]); without it, the NLM ID.
  const converted = pubmedConversion(journal!);
  assert.equal(buildPubmedQuery(converted.builder), '(PLoS Pathog[Journal])');
  assert.equal(converted.limit, 20);
  assert.equal(buildPubmedQuery(pubmedConversion(pubmedRssSource('https://pubmed.ncbi.nlm.nih.gov/rss/journals/101238921/')!).builder), '(101238921[jid])');
  // A search RSS id is opaque: the builder starts empty.
  assert.equal(buildPubmedQuery(pubmedConversion(pubmedRssSource('https://pubmed.ncbi.nlm.nih.gov/rss/search/abc/')!).builder), '');

  // The default name is the query exactly, then " - PubMed"; a query too long for a name loses its middle.
  assert.equal(pubmedDefaultName('(Mengmeng Lin[Author]) AND (ShanghaiTech[Affiliation])'), '(Mengmeng Lin[Author]) AND (ShanghaiTech[Affiliation]) - PubMed');
  const long = `(${'a'.repeat(150)}[Title]) AND (${'b'.repeat(150)}[Affiliation])`;
  const name = pubmedDefaultName(long);
  assert.equal(name.length, 200);
  assert.ok(name.startsWith('(aaaa') && name.endsWith('b[Affiliation]) - PubMed') && name.includes('…'), name);
});
