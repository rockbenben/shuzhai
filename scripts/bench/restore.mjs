// 无文件书恢复测量：只生成一次性书库，不读取用户档案。
// node scripts/bench/restore.mjs --out <JSON> [--compare <旧JSON>]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/core/db.ts';
import { BACKUP_VERSION, exportBackup, importBackup } from '../../src/core/backup.ts';
import { median } from './report.mjs';

const option = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${name} 缺少路径`);
  return process.argv[i + 1];
};
const root = mkdtempSync(join(tmpdir(), 'shuzhai-restore-bench-'));
const results = [];
try {
  for (const size of [500, 1000, 2000]) {
    const books = Array.from({ length: size }, (_, i) => ({
      title: `只有记录 ${i}`, author: `作者 ${i % 23}`, aliases: null, intro: null,
      serialStatus: 'unknown', sourceSite: null, note: `个人备注 ${i}`, categoryName: null,
      tags: ['临时标签'], files: [],
      reading: { status: 'finished', chapterIdx: 0, charOffset: 0, percent: 100,
        rating: 4, comment: `第 ${i} 本的书评`, ratedAt: '2026-01-01 00:00:00',
        dropReason: null, rereadCount: 0, lastReadAt: null, finishedAt: '2026-01-01 00:00:00' },
      bookmarks: [], highlights: [], sessions: [],
    }));
    const backup = { version: BACKUP_VERSION, createdAt: '2026-01-01T00:00:00Z',
      books, cleanRules: [], categories: [], shelves: [], settings: {} };
    const samples = { empty: [], existing: [] };
    for (let run = 0; run < 6; run++) {
      const db = openDb(join(root, `${size}-${run}.db`));
      try {
        let reads = 0;
        const prepare = db.prepare.bind(db);
        db.prepare = (sql, ...args) => {
          const stmt = prepare(sql, ...args);
          if (/^select id, title, author from book(?: order by id)?$/i.test(sql.trim())) {
            const all = stmt.all.bind(stmt);
            stmt.all = (...params) => { reads++; return all(...params); };
          }
          return stmt;
        };
        for (const scope of ['empty', 'existing']) {
          reads = 0;
          const start = performance.now();
          const report = importBackup(db, backup);
          const ms = performance.now() - start;
          const fullReads = reads;
          assert.equal(report.matched, size);
          assert.equal(report.createdBooks, scope === 'empty' ? size : 0);
          assert.equal(report.unmatched.length, 0);
          const restored = exportBackup(db);
          delete restored.createdAt;
          assert.deepEqual(restored.books.map((b) => [b.title, b.author, b.reading.comment]),
            books.map((b) => [b.title, b.author, b.reading.comment]));
          const identities = db.prepare('select id, title, author from book order by id').all();
          const digest = createHash('sha256').update(JSON.stringify({ report, restored, identities })).digest('hex');
          if (run > 0) samples[scope].push({ ms, fullReads, digest }); // 第一轮预热不计
        }
      } finally { db.close(); }
    }
    for (const scope of ['empty', 'existing']) {
      assert.equal(new Set(samples[scope].map((x) => x.digest)).size, 1, '每次恢复结果必须一致');
      const row = { size, scope, medianMs: median(samples[scope].map((x) => x.ms)), samples: samples[scope] };
      results.push(row);
      console.log(`${size} ${scope}: ${row.medianMs.toFixed(2)} ms / 全表读取 ${samples[scope][0].fullReads}`);
    }
  }
  const previous = option('--compare');
  if (previous) {
    const before = JSON.parse(readFileSync(previous, 'utf8'));
    assert.deepEqual(results.map((x) => [x.size, x.scope, x.samples[0].digest]),
      before.results.map((x) => [x.size, x.scope, x.samples[0].digest]), '优化前后逐本数据、ID、报告不同');
    console.log('优化前后逐本数据、ID、恢复报告一致');
  }
  const out = option('--out');
  if (out) writeFileSync(out, JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
} finally {
  // root 直接来自 mkdtemp；不接收外部待清理路径。
  rmSync(root, { recursive: true, force: true });
}
