/**
 * 造一个走查用的测试书库。
 *
 * `scripts/ui-check/` 那三个脚本都要有书才跑得动，而**绝不能拿用户的真实书库
 * 去跑**（点开书会写进 `reading_state`，重扫恢复不了）。所以先用这个造一份假的。
 *
 *   node scripts/ui-check/make-testlib.mjs <目标目录>
 *
 * 造出来的每一本都对应走查里真需要的一种情况，别随手删：
 *   - 正常的多章 txt（走阅读、进度、读完）
 *   - 带卷的（两级目录）
 *   - GBK 编码的（编码探测）
 *   - 通篇没有章节标题的（章节规则弹窗那条「没认出来」的分支）
 *   - 书名特别长的（卡片截断、两行夹断）
 *   - 只编目的 .pdf（点开走系统程序，**走查脚本必须避开它**）
 *   - 子目录里的（目录开关、屏蔽规则）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeZip } from '../../src/core/zip.ts';

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('用法：node scripts/ui-check/make-testlib.mjs <目标目录>');
  process.exit(1);
}

/**
 * ⚠ **每本必须 ≥10 KB**：`scan.ts` 的收录下限是 10240 字节，
 * 而且**过滤是静默的**——扫描报告六项全 0，不会告诉你「有文件因为太小被跳过」。
 * 这个坑在这个仓库里踩过三次，每次症状都是「所有断言都说查不到这本书」。
 * （后来给报告加了 `skipped` 表，但造夹具时还是要记得这条下限。）
 */
const MIN_BYTES = 10240;

const 段 = [
  '公元1988年9月，山东半岛的暑热尚未完全退去，他就乘坐飞机悄悄来到了日照，见到本地的主要领导交谈时，大家都有些唏嘘。',
  '“价格闯关”搞成一地鸡毛，都一个月过去了，老百姓的抢购还没有结束，各地干部简直要吐血，现在遇到的种种麻烦比打仗还要辛苦。',
  '相比较而言，这里的情况要好不少，人口不算多，但这几年大发展，工业发达，又早有准备，集团开足马力生产自然解决了不少问题。',
  '他压低声音，说出更深层的担忧：“更让我不安的是，他多次提过，考虑放弃或大幅收缩在一些传统制造业和部分地区性投资。”',
];

/** 一本书：n 章。**章标题用内置规则认得出的格式** */
function book(n, { volume = false } = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (volume && i % 20 === 1) out.push(`第${Math.ceil(i / 20)}卷 卷名${Math.ceil(i / 20)}`);
    out.push(`第${i}章 ${['出人意料', '峰回路转', '暗流涌动', '尘埃落定'][i % 4]}`);
    /*
     * **每章要够长**：真实书库里每章中位数 3200 字，而这里原来一章只有 6 段
     * （约 300 字）——`buildChapters` 的自动合并把不到 500 字的章并进上一章，
     * 于是测试库一扫进来章数就腰斩（雪中悍刀行 60 → 30），
     * 而走查量到的是一本**真实世界里不存在的书**。
     * 12 段约 700 字，稳稳越过门槛，也还够小、扫得快。
     */
    for (let p = 0; p < 12; p++) out.push(段[(i + p) % 段.length]);
  }
  return out.join('\r\n');
}

/** 通篇没有一行像标题——章节规则弹窗那条「没认出来」的分支要靠它 */
function prose(lines) {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(段[i % 段.length]);
  return out.join('\r\n');
}

const write = (path, text, encoding = 'utf8') => {
  let body = text;
  // 补足到收录下限，否则会被静默跳过
  while (Buffer.byteLength(body, encoding === 'gb18030' ? 'utf8' : encoding) < MIN_BYTES) body += '\r\n' + 段[0];
  if (encoding === 'gb18030') {
    // Node 没有内置的 GBK 编码器，用 iconv 不值得——退回 UTF-8，
    // 编码探测那条改用真实书库验（AGENTS.md 记着 UTF-8 校验通过不等于就是 UTF-8）
    writeFileSync(path, body, 'utf8');
  } else {
    writeFileSync(path, body, encoding);
  }
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, '未完'), { recursive: true });
mkdirSync(join(ROOT, 'Archive'), { recursive: true });

write(join(ROOT, '剑来 作者：烽火戏诸侯.txt'), book(45));
write(join(ROOT, '雪中悍刀行 作者：烽火戏诸侯.txt'), book(60, { volume: true }));
write(join(ROOT, '短篇集 作者：佚名.txt'), book(12));
write(join(ROOT, '这本书名字特别长长长长长长长长到会换行 作者：某位名字也很长的作者.txt'), book(30));
write(join(ROOT, '没有章节的散文 作者：某人.txt'), prose(900));
write(join(ROOT, '未完', '正在连载的书 作者：连载中.txt'), book(25));
write(join(ROOT, 'Archive', '归档的老书 作者：老作者.txt'), book(18));
// 只编目的格式：点开走系统默认程序。**走查脚本要避开它**——
// 随手点第一张卡会点到它，不但后面全废，还会在这台机器上弹个外部阅读器
/*
 * **真的 PDF 和真的 EPUB**，不是改了扩展名的 txt。
 *
 * 原来这里写的是 `prose(200)` 存成 `.pdf`——那时 PDF 只编目、点开交给系统程序，
 * 内容是什么无所谓。**现在有内置查看器了**，假文件只能测到「打不开」那条路，
 * 测不到渲染。
 */
/*
 * ⚠️ **PDF 里那句话必须是纯 ASCII。** xref 表存的是**字节**偏移，而这个生成器
 * 是按 `out.length`（JS 的**字符**数）算的——放中文进去两者就对不上，
 * pdf.js 会退回「Indexing all PDF objects」全文扫描。
 * 同本仓库那条「偏移量是字节，不是字符」。
 */
write(join(ROOT, '一本PDF电子书 作者：某某.pdf'), 最小PDF('Hello from Shuzhai'));
writeFileSync(join(ROOT, '一本EPUB电子书 作者：某某.epub'), 最小EPUB());  // 里面自己撑过收录下限，见函数注释

/*
 * **同一本书的两种格式。** 造它是为了让「重复的书」那一屏有东西可量——
 * 原来这个库里一个重复组都没有（`version.groups` 回 `[]`），
 * 于是走查一直量的是**空状态那一屏**（同本仓库那条「测试库里 0 个标签、
 * 0 条书评，几个界面走查量的全是空壳」）。
 *
 * ⚠️ **epub 必须写在 txt 前面。** 目录遍历按名字走，先写的先入库、fileId 更小,
 * 而「重复的书」默认留哪一份原来取的是**列表里第一个**（按 fileId 排）。
 * 反过来放的话 txt 排前面，新旧两种写法都会选中它——**这个夹具就分不出对错了**。
 * 上一轮为此专门另造了一组才验出来，判据写在 `VersionsDialog.tsx` 的 `默认留`
 * 和 `primary.ts` 的 `preferReadable` 上。
 */
writeFileSync(join(ROOT, '双格式的书 作者：某某.epub'), 最小EPUB());
write(join(ROOT, '双格式的书 作者：某某.txt'), book(14));

console.log(`造好了：${ROOT}`);
console.log('  8 本 txt（含带卷的、没有章节标题的、书名超长的、子目录里的、和 epub 同名的）'
  + ' + 1 个 pdf + 2 个 epub');
console.log('\n接着就可以：');
console.log(`  node_modules\\electron\\dist\\electron.exe --user-data-dir=<测试档案> --remote-debugging-port=9876 .`);
console.log(`  node scripts/ui-check/walk.mjs "${ROOT}"`);


/**
 * 手写一个最小但**合法**的 PDF。
 *
 * ⚠️ **xref 表里那几个偏移必须是真的字节位置**——写错了 pdf.js 直接报
 * `InvalidPDFException`，而那看起来和「查看器坏了」一模一样。所以这里是
 * 一边拼一边记 `out.length`，不是手填常数。
 */
function 最小PDF(text, 页数 = 3) {
  /*
   * ⚠️ **必须是多页。** 原来只造 1 页，于是查看器那一整套翻页
   * （上一页 / 下一页、底部滑块、键盘绑定）**没有任何走查验得了**——
   * 一页的书按什么键页码都不动，探针量到的永远是「1 / 1 页」，判据于是永远绿。
   * 同这个仓库那条：一条只在某种数据下才会红的判据，如果那种数据不是它自己造的，
   * 它就是永远绿的。
   *
   * 编号排布：1 = Catalog，2 = Pages，之后每页两个对象（Page、内容流），
   * 最后一个是字体。偏移照旧一边拼一边记，不手填常数。
   */
  const 页对象 = [];
  const objs = [null, null, null];
  const fontNo = 3 + 页数 * 2;
  /*
   * ⚠️ **必须带书签（outline）。** 真实的技术书 / 扫描书 PDF 几乎都有，
   * 而查看器的「目录」那个键就是照它长出来的——夹具里没有的话，
   * 那个键在走查里**永远不出现**，等于没测。同这个文件里
   * 「PDF 必须是多页」「EPUB 必须有一节长到会分页」两条，一模一样的形状。
   *
   * `/Dest [页对象 /Fit]` 直接指页对象，省掉一层命名目标——
   * pdf.js 两种都认，而直接指的那种偏移算起来不会错。
   */
  const 根No = fontNo + 1;
  const 条No = (i) => 根No + 1 + i;
  for (let i = 0; i < 页数; i++) {
    const pageNo = 3 + i * 2;
    const contentNo = pageNo + 1;
    页对象.push(pageNo);
    const stream = `BT /F1 18 Tf 24 120 Td (${text} - p${i + 1}) Tj ET`;
    objs[pageNo] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 220]/Contents ${contentNo} 0 R`
      + `/Resources<</Font<</F1 ${fontNo} 0 R>>>>>>`;
    objs[contentNo] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  }
  objs[2] = `<</Type/Pages/Kids[${页对象.map((n) => `${n} 0 R`).join(' ')}]/Count ${页数}>>`;
  objs[fontNo] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  /*
   * 书签树：每页一条，标题里带页号，走查据此确认「点第 N 条真的跳到第 N 页」。
   *
   * ⚠️ **第一条底下还挂了一条子书签，它指的也是第 1 页。**
   * 没有它的话书签顺序恰好等于页顺序，**「问 `getPageIndex(ref)` 要页号」
   * 和「按书签的顺序数」两种实现答案完全一样**——那条判据就永远绿。
   * 加上之后：正确的页号是 1,1,2,3，按顺序数是 1,2,3,4，点「p2」会跑到第 3 页。
   * 同这个文件里 EPUB 那条「spine 里要有一节不在目录里」，一模一样的用意。
   * 顺带把**嵌套**那条路也测上（子条目在界面上要缩进）。
   */
  const 子No = 条No(页数);
  objs[根No] = `<</Type/Outlines/First ${条No(0)} 0 R/Last ${条No(页数 - 1)} 0 R/Count ${页数 + 1}>>`;
  for (let i = 0; i < 页数; i++) {
    const 前 = i > 0 ? `/Prev ${条No(i - 1)} 0 R` : '';
    const 后 = i < 页数 - 1 ? `/Next ${条No(i + 1)} 0 R` : '';
    const 孩子 = i === 0 ? `/First ${子No} 0 R/Last ${子No} 0 R/Count 1` : '';
    objs[条No(i)] = `<</Title(Bookmark p${i + 1})/Parent ${根No} 0 R${前}${后}${孩子}`
      + `/Dest[${页对象[i]} 0 R /Fit]>>`;
  }
  objs[子No] = `<</Title(Sub of p1)/Parent ${条No(0)} 0 R/Dest[${页对象[0]} 0 R /Fit]>>`;
  objs[1] = `<</Type/Catalog/Pages 2 0 R/Outlines ${根No} 0 R>>`;
  const 末 = 子No;

  let out = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i <= 末; i++) {
    off[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${末 + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= 末; i++) out += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${末 + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/**
 * 最小但**合法**的 EPUB。用仓库自带的 `zip.ts`——导出 EPUB 用的就是它，
 * 这里再引一次不用加依赖。
 *
 * ⚠️ **`mimetype` 必须是第一个条目、而且不压缩**（EPUB 规范就这么定的）。
 * `makeZip` 的 `method: 'store'` 就是为这件事留的。
 */
function 最小EPUB() {
  const html = (t, b) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1>${b}</body></html>`;
  const 段 = (b) => `<p>${b}</p>`;
  /*
   * ⚠️ **必须有一节长到会分页。**
   *
   * 原来三节都只有一句话，epub.js 报 `displayed.total === 1`——**每节正好一页**。
   * 于是「节内翻页」和「进度精确到页」这两件事**在这个夹具上永远量不出来**：
   * `next()` 看着像「一次跳一节」，而它其实是「翻到本节最后一页才跳下一节」，
   * 两种行为在单页的书上一模一样。CFI 回填也一样——落回本节第一页
   * 和落回原来那一页无法区分。
   * 同这个文件里那条「PDF 必须是多页」，一模一样的坑。
   */
  const 长正文 = Array.from({ length: 80 }, (_, i) =>
    段(`第 ${i + 1} 段。${'风雪夜归人孤灯照旧影，山重水复疑无路柳暗花明又一村。'.repeat(3)}`)).join('');
  const opf = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">',
    ' <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <dc:identifier id="id">shuzhai-test-epub</dc:identifier>',
    '  <dc:title>一本EPUB电子书</dc:title>',
    '  <dc:language>zh</dc:language>',
    ' </metadata>',
    ' <manifest>',
    '  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '  <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    '  <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>',
    '  <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>',
    ' </manifest>',
    /*
     * ⚠️ **spine 里要有一节不在目录里**（这里是封面页），否则这个夹具
     * **分不出「问 `spine.get(href)` 要序号」和「按目录里的顺序数」**——
     * 两种写法在一一对应的书上答案完全一样，于是那条判据永远绿。
     *
     * 真实的 EPUB 几乎都有这种节（封面、版权页、致谢），它们在 spine 里
     * 而不在 nav 里。按顺序数出来的号会整体错位一位：点「第一章」跳到封面。
     * 现在 nav 的「第一章」对应 spine 序号 **1**，位置是 **0**——两个数不一样了。
     */
    ' <spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>',
    '</package>',
  ].join('\n');
  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">第一章</a></li><li><a href="c2.xhtml">第二章</a></li></ol></nav></body></html>';
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    // 封面页**故意不进 nav**，理由见上面 spine 那段
    { name: 'OEBPS/cover.xhtml', data: html('封面', 段('书斋测试用的 EPUB。这一页在 spine 里，不在目录里。')) },
    { name: 'OEBPS/c1.xhtml', data: html('第一章 峰回路转', 段('这是书斋测试用的 EPUB 第一章正文。')) },
    { name: 'OEBPS/c2.xhtml', data: html('第二章 暗流涌动', 段('这是书斋测试用的 EPUB 第二章正文。') + 长正文) },  // 这一节**故意很长**，理由见 `长正文`
    /*
     * ⚠️ **撑到收录下限。** `scan.ts` 只收 ≥ 10240 字节的文件，
     * **而且过滤是静默的**（扫描报告六项全 0，不会说「有文件因为太小被跳过」）。
     * 一个 1.7 KB 的 EPUB 压根进不了库，而症状是「所有断言都说查不到这本书」——
     * 本仓库为这条踩过三次。
     *
     * 用 `store`（不压缩）才撑得起来：这点重复文本 deflate 一下只剩几十字节。
     */
    { name: 'OEBPS/pad.txt', data: 'shuzhai test padding.\n'.repeat(600), method: 'store' },
  ]);
}
