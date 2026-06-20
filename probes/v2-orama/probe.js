// V2 probe (SPEC §1): does the embedded Orama index round-trip?
//   chunk + insert large output under source="exec:<id>",
//   BM25-search a buried line back, scope by source,
//   then persist -> restore from disk and search again.
//
// Run:  node probe.js
// Exit: 0 = all checks pass, 1 = a check failed.

import { create, insertMultiple, search, count } from '@orama/orama';
// File-based persist/restore live in the /server subpath (the bare entry is
// the in-memory persist()/restore() that round-trip a string/Buffer).
import { persistToFile, restoreFromFile } from '@orama/plugin-data-persistence/server';
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, 'index-snapshot.json');
const CHUNK_LINES = 20;

// ── assertion helper ───────────────────────────────────────────────────────
let failed = false;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── schema ───────────────────────────────────────────────────────────────────
// text   = full-text BM25 field (the chunk body)
// source = EXACT-match filter field. NB: must be `enum`, not `string`.
//          A `string` field is tokenized for full-text, so where:{source} would
//          do a fuzzy term match; `enum` gives exact eq/in equality, which is
//          what scoping recall to one capture ("exec:<id>") requires.
const schema = { text: 'string', source: 'enum', startLine: 'number' };

// ── synthetic "truncated bash output": two captures, each large ──────────────
const NEEDLE = 'ZEBRACORN_4f9a'; // unique token buried deep in source A only
function makeOutput({ lines, needleAt, needleText }) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(i === needleAt
      ? `line ${i}: ${needleText}`
      : `line ${i}: routine log entry alpha beta gamma delta ${i * 7 % 1000} ok`);
  }
  return out.join('\n');
}

function chunk(text, source) {
  const lines = text.split('\n');
  const docs = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    docs.push({
      text: lines.slice(i, i + CHUNK_LINES).join('\n'),
      source,
      startLine: i,
    });
  }
  return docs;
}

async function buildIndex() {
  const db = create({ schema });
  const srcA = 'exec:aaa111';
  const srcB = 'exec:bbb222';

  // A: needle buried at line 1234 of 3000 (~>50KB, the "truncated" case)
  const outA = makeOutput({ lines: 3000, needleAt: 1234, needleText: `${NEEDLE} eviction policy mismatch here` });
  // B: a different capture that ALSO mentions the needle token — proves the
  //    source filter actually narrows, rather than the term just being unique.
  const outB = makeOutput({ lines: 800, needleAt: 400, needleText: `${NEEDLE} appears in OTHER capture` });

  const docsA = chunk(outA, srcA);
  const docsB = chunk(outB, srcB);
  await insertMultiple(db, docsA);
  await insertMultiple(db, docsB);

  console.log(`  built: ${docsA.length} chunks (A) + ${docsB.length} chunks (B), bytesA=${Buffer.byteLength(outA)}`);
  return { db, srcA, srcB };
}

async function main() {
  await rm(SNAPSHOT, { force: true });

  console.log('1. build + insert');
  const { db, srcA, srcB } = await buildIndex();

  console.log('2. BM25 retrieval, scoped to source A');
  const rA = await search(db, { term: NEEDLE, where: { source: { eq: srcA } }, limit: 3 });
  const topA = rA.hits[0];
  check('found a hit in A', rA.count > 0 && topA);
  check('top hit carries the buried needle line', topA?.document.text.includes('eviction policy mismatch'),
    topA ? `startLine=${topA.document.startLine}` : 'no hit');
  check('top hit is scoped to source A', topA?.document.source === srcA, topA?.document.source);
  check('every hit is from source A (filter holds)', rA.hits.every(h => h.document.source === srcA));

  console.log('3. scope filter narrows: same term, source B');
  const rB = await search(db, { term: NEEDLE, where: { source: { eq: srcB } }, limit: 3 });
  check('source B returns its OWN chunk, not A\'s',
    rB.hits.length > 0 && rB.hits.every(h => h.document.source === srcB),
    `B hits=${rB.hits.length}`);
  check('B\'s needle text differs from A\'s', rB.hits[0]?.document.text.includes('OTHER capture'));

  console.log('4. persist to disk (json)');
  await persistToFile(db, 'json', SNAPSHOT);
  const sz = (await stat(SNAPSHOT)).size;
  check('snapshot file written', sz > 0, `${sz} bytes`);

  console.log('5. restore into a fresh instance');
  const db2 = await restoreFromFile('json', SNAPSHOT);
  check('doc count survived restore', (await count(db2)) === (await count(db)),
    `restored=${await count(db2)} original=${await count(db)}`);

  console.log('6. BM25 retrieval AFTER restore (the real V2 question)');
  const rR = await search(db2, { term: NEEDLE, where: { source: { eq: srcA } }, limit: 3 });
  check('buried needle still retrieved post-restore', rR.hits[0]?.document.text.includes('eviction policy mismatch'),
    rR.hits[0] ? `startLine=${rR.hits[0].document.startLine}` : 'no hit');
  check('post-restore scope filter still holds', rR.hits.every(h => h.document.source === srcA));

  await rm(SNAPSHOT, { force: true });

  console.log('');
  console.log(failed ? 'V2 PROBE: FAIL' : 'V2 PROBE: PASS — round-trip + persist/restore + scoped BM25 all work');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
