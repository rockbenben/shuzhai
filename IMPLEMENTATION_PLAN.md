# 全量审计实施计划：逐条检查并更新注释、docs、readme

## Stage 1: 变更盘点与现状梳理
**Goal**: 梳理从 v1.0.1 (3446013) 以来的所有功能改动、新增模块、新增 RPC、数据表及字段变更、书架/阅读器体验更新，比对现有注释、文档及 README 的滞后与矛盾之处。
**Success Criteria**:
- 确定所有新增/变动模块（site-adapters, links, enrich, cover-fetcher, shelf, library, scan, reader, rpc, BookEditor, etc.）
- 整理出注释、docs、readme、AGENTS.md、spec 中所有需要同步或修复的陈旧/冲突表述清单
**Tests**: `node scripts/counts.mjs`, `git diff 3446013..HEAD --stat`
**Status**: Complete

## Stage 2: 源码注释逐条检查与更新
**Goal**: 检查核心模块（`src/core/`, `src/main/`, `src/renderer/`）中的注释，修正因近期功能迭代（连载更新检查、覆盖重读、stale 失效清理、手填章数、站点适配器、批量封面优化等）导致的过时或不准确注释。
**Success Criteria**:
- 所有模块头注释、函数注释、字段注释与实际实现及现状一致
- 无过时的死引用或自相矛盾说明
**Tests**: `npm run lint:ui`, `npm test`
**Status**: Complete

## Stage 3: 文档体系审计与更新（docs + AGENTS.md + spec）
**Goal**: 更新 `AGENTS.md`、`docs/lessons.md`、`novel-manager-spec.md` 及相关走查文档。
**Success Criteria**:
- `AGENTS.md` 解决内部自相矛盾（如 CI 运行状态），同步新增模块（如 site-adapters.ts、links.ts 新增连载检测能力、stale 清理等）、更新模块映射与判据表
- `docs/lessons.md` 补充近期排查经验与实测判据
- `novel-manager-spec.md` 明确记录实际落地的最新功能与演进
**Tests**: `npm run lint:ui`, `node scripts/counts.mjs`
**Status**: Complete

## Stage 4: 用户文档与品牌说明更新（README.md + brand）
**Goal**: 更新 `README.md` 与相关文案，确保功能特性清单、联网说明、格式与能力支持与最新版本完全一致。
**Success Criteria**:
- `README.md` 完整反映当前版本能力（追更/连载更新检测、手填章数、失效清理、联网补全元数据、占位封面题签优化等）
- 准确陈述联网行为与隐私边界
**Tests**: 文本走查与链接校验
**Status**: In Progress

## Stage 5: 全量验证与交付
**Goal**: 运行全套质量门禁，确认测试、类型检查、静态走查、数据库一致性全部绿灯。
**Success Criteria**:
- `npm test` 全绿
- `npm run typecheck` 0 报错
- `npm run lint:ui` 0 报错
- `node scripts/integrity.mjs` 0 异常
**Tests**: `npm test`, `npm run typecheck`, `npm run lint:ui`, `node scripts/integrity.mjs`
**Status**: Not Started
