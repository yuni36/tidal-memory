#!/usr/bin/env node
/**
 * reindex-chroma-cosine.js
 *
 * 将 Chroma collection 重建为 hnsw:space=cosine，并从 SQLite 全量重嵌。
 * 修「1-distance 当余弦」与默认 L2 空间不匹配的问题。
 *
 * 用法（容器内）:
 *   node scripts/reindex-chroma-cosine.js
 *   node scripts/reindex-chroma-cosine.js --probe 理财 食堂 小组汇报
 */
'use strict';

const { initDatabase, getDb } = require('../database');
const { encryption } = require('../encryption');
const { chromaDBOperation, searchMemoriesByVector } = require('../services/memory');

const BATCH = 40;

async function main() {
  initDatabase();
  const db = getDb();

  console.log('[reindex] reset_collection → cosine');
  const reset = await chromaDBOperation('reset_collection', { confirm: true });
  console.log(JSON.stringify(reset));

  const frags = db.prepare(`
    SELECT id, content, entity, emotional_weight, source, source_date
    FROM memory_fragments
    WHERE status = 'active'
    ORDER BY id
  `).all();

  let indexed = 0;
  for (let i = 0; i < frags.length; i += BATCH) {
    const slice = frags.slice(i, i + BATCH);
    const items = slice.map((f) => ({
      id: `fragment_${f.id}`,
      text: f.content || '',
      metadata: {
        entity: f.entity || '',
        content: String(f.content || '').slice(0, 200),
        emotional_weight: f.emotional_weight ?? 0.5,
        source: f.source || '',
        source_date: f.source_date || '',
      },
    }));
    const result = await chromaDBOperation('index_batch', { items });
    const n = result.indexed || 0;
    indexed += n;
    const upd = db.prepare('UPDATE memory_fragments SET chroma_id = ? WHERE id = ?');
    for (const f of slice) {
      upd.run(`fragment_${f.id}`, f.id);
    }
    console.log(`[reindex] fragments ${Math.min(i + BATCH, frags.length)}/${frags.length} (+${n})`);
  }

  // episode memories（有内容的）
  let memIndexed = 0;
  let episodes = [];
  try {
    episodes = db.prepare(`
      SELECT id, title, content, tags
      FROM memories
      WHERE layer = 'episode' AND status = 'permanent'
      ORDER BY id
    `).all();
  } catch (e) {
    console.log('[reindex] memories skip:', e.message);
  }

  for (let i = 0; i < episodes.length; i += BATCH) {
    const slice = episodes.slice(i, i + BATCH);
    const items = slice.map((m) => {
      let title = m.title || '';
      let content = m.content || '';
      try { title = encryption.decrypt(title); } catch (_) {}
      try { content = encryption.decrypt(content); } catch (_) {}
      return {
        id: `memory_${m.id}`,
        text: `${title}\n${content}`.trim(),
        metadata: {
          tags: m.tags || '[]',
          content: String(content).slice(0, 200),
        },
      };
    }).filter((it) => it.text.length > 0);
    if (items.length === 0) continue;
    const result = await chromaDBOperation('index_batch', { items });
    const n = result.indexed || 0;
    memIndexed += n;
    const upd = db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?');
    for (const m of slice) {
      upd.run(`memory_${m.id}`, m.id);
    }
    console.log(`[reindex] episodes ${Math.min(i + BATCH, episodes.length)}/${episodes.length} (+${n})`);
  }

  console.log(JSON.stringify({
    fragments: frags.length,
    fragIndexed: indexed,
    episodes: episodes.length,
    memIndexed,
  }));

  const probeIdx = process.argv.indexOf('--probe');
  if (probeIdx < 0) return;

  const qs = process.argv.slice(probeIdx + 1).filter((a) => !a.startsWith('--'));
  const { searchHybrid } = require('../services/librarian');
  for (const q of qs) {
    const vec = await searchMemoriesByVector(q, 5);
    const hybrid = await searchHybrid(q, 8);
    console.log(JSON.stringify({
      q,
      vecTop: vec.slice(0, 3).map((v) => ({
        id: v.id,
        sim: Number((v._similarity || 0).toFixed(3)),
        peek: String(v.content || '').slice(0, 40),
      })),
      vecPass022: vec.filter((v) => (v._similarity || 0) >= 0.22).length,
      hybrid: hybrid.length,
    }));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
