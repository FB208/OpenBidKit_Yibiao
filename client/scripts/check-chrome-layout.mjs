// 运行：node scripts/check-chrome-layout.mjs
import assert from 'node:assert/strict';
import {
  buildChrome, formatPageNumber, cmToSvg, resolveChromeGeometryDefaults,
  HEADER_CHROME_HEIGHT_RANGE_CM, FOOTER_CHROME_HEIGHT_RANGE_CM,
} from '../electron/shared/chrome/index.mjs';
import { n } from '../electron/shared/chrome/svgUtil.mjs';

const page = { header_enabled: true, header_text: '标题', header_badge_text: '易标', footer_enabled: true, footer_text: '页脚正文', page_number_enabled: true, footer_distance_cm: 1 };
const styles = ['plain', 'rules', 'band', 'top-bar', 'footer-badge', 'slant', 'letterhead', 'frame'];

// 分区样式不随正文对齐或开关移动页码，距离设置让全部页脚文字同步平移。
for (const style of styles) {
  const config = { ...page, header_footer_style: style };
  const { textLayout: original } = buildChrome(config);
  const moved = buildChrome({ ...config, footer_distance_cm: 2 }).textLayout;
  const aligned = buildChrome({ ...config, footer_alignment: '右对齐' }).textLayout;
  const noText = buildChrome({ ...config, footer_enabled: false }).textLayout;
  const noNumber = buildChrome({ ...config, page_number_enabled: false }).textLayout;
  const footer = original.footer;
  assert.deepEqual(aligned.footer.pageNumber.box, footer.pageNumber.box);
  assert.deepEqual(noText.footer.pageNumber.box, footer.pageNumber.box);
  assert.deepEqual(noNumber.footer.box, footer.box);
  if (style === 'plain') {
    // 无装饰，文字走普通段落流
    assert.equal(footer.box, null);
    assert.equal(footer.pageNumber.box, null);
    continue;
  }
  // 有装饰时页眉贴顶，正文让开装饰带
  assert.equal(buildChrome(config).layout.headerDistanceCm, 0);
  assert.ok(buildChrome({ ...config, margin_top_cm: 1 }).layout.marginTopCm > 1.6,
    `${style} 的正文上边距没让开页眉装饰`);
  if (style === 'rules') {
    // 文武线不分区：页码与正文合排在同一块里，但仍是相对纸张的绝对定位
    assert.ok(footer.box, 'rules 的页脚文字缺少定位区域');
    assert.equal(footer.pageNumber.box, null);
    assert.ok(footer.box.heightCm > 0 && footer.box.endCm > footer.box.startCm);
    assert.ok(Math.abs(moved.footer.box.topCm - footer.box.topCm + 1) < 1e-9);
    continue;
  }
  assert.ok(footer.box.endCm <= footer.pageNumber.box.startCm, `${style} 的正文与页码区域重叠`);
  for (const part of [footer.box, footer.pageNumber.box]) assert.ok(part.heightCm > 0 && part.endCm > part.startCm);
  assert.ok(Math.abs(moved.footer.box.topCm - footer.box.topCm + 1) < 1e-9);
  assert.ok(Math.abs(moved.footer.pageNumber.box.topCm - footer.pageNumber.box.topCm + 1) < 1e-9);
  const landscape = buildChrome({ ...config, orientation: 'landscape' }).textLayout.footer;
  assert.ok(landscape.pageNumber.box.startCm > footer.pageNumber.box.startCm);
  if (style === 'band') assert.equal(original.header.badge.box.endCm, original.header.box.startCm);
}

// plain 不生成装饰图，就不能占装饰带高度，也不能改页眉距顶 —— 用户的页面设置要原样保留
{
  const plain = buildChrome({ ...page, header_footer_style: 'plain', margin_top_cm: 1 });
  assert.equal(plain.headerSvg, null, 'plain 不应生成页眉装饰');
  assert.equal(plain.layout.headerHeightCm, 0, 'plain 不应占用装饰带高度');
  assert.equal(plain.layout.marginTopCm, 1, 'plain 不应抬高用户设置的正文上边距');
  assert.equal(plain.layout.headerDistanceCm, 1.25, 'plain 的页眉应保持 Word 默认距顶');
}

// 短标记是 band 独有的，从 band 切到别的样式后不能把残留值带进页眉正文
for (const style of styles) {
  const { textLayout } = buildChrome({ ...page, header_footer_style: style, header_badge_text: '易标' });
  if (style === 'band') {
    assert.equal(textLayout.header.badgeText, '易标');
    assert.ok(textLayout.header.badge, 'band 的短标记缺少落点');
  } else {
    assert.equal(textLayout.header.badgeText, '', `${style} 不应保留短标记`);
    assert.equal(textLayout.header.badge, null);
  }
}

// 文本框高度必须跟着字号走，而不是写死成装饰带高度：
// 大字号要能撑开，且撑开后仍留在纸张内（距底边为 0 时最容易越界）。
{
  const { lineHeightCm } = await import('../electron/shared/chrome/geometry.mjs');
  const pageHeightCm = 29.7;
  for (const style of styles) {
    for (const size of ['小五', '小二', '初号']) {
      const need = lineHeightCm(size);
      const cfg = { ...page, header_footer_style: style, header_size: size, footer_size: size, footer_distance_cm: 0 };
      const { header, footer } = buildChrome(cfg).textLayout;
      for (const [label, box, text] of [
        ['页眉', header.box, header.text], ['徽标', header.badge?.box, header.badgeText],
        ['页脚', footer.box, footer.text],
        ['页码', footer.pageNumber.box, formatPageNumber('00', footer.pageNumber.format, 0)],
      ]) {
        if (!box) continue;
        const where = `${style}/${size}/${label}`;
        // 折行后每一行都要有地方放：按全角 1em / 半角 0.5em 估宽
        let em = 0;
        for (const ch of String(text || '')) em += /[⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 1 : 0.5;
        const wide = em * (need / 1.2);
        const lines = Math.min(6, Math.max(1, Math.ceil(wide / (box.endCm - box.startCm))));
        assert.ok(box.heightCm + 1e-9 >= need * lines,
          `${where} 的文本框装不下 ${lines} 行文字`);
        assert.ok(box.topCm >= -1e-9, `${where} 越过纸张上边`);
        assert.ok(box.topCm + box.heightCm <= pageHeightCm + 1e-9, `${where} 越过纸张下边`);
      }
    }
  }
  // 默认小五不该改变任何既有几何
  const base = buildChrome({ ...page, header_footer_style: 'band' }).textLayout;
  assert.equal(base.footer.box.heightCm, 360 / 567, '小五不应撑开色带页脚');
  assert.equal(base.header.box.heightCm, 1.35, '小五不应撑开页眉装饰带');
}

// 评审给的具体场景：top-bar + 小一 + 「第{page}页」，1.6cm 宽的页码区放不下一行
{
  const { lineHeightCm } = await import('../electron/shared/chrome/geometry.mjs');
  const t = buildChrome({ ...page, header_footer_style: 'top-bar', footer_size: '小一' }).textLayout;
  assert.ok(t.footer.pageNumber.box.heightCm > lineHeightCm('小一') * 1.5,
    '窄页码区在大字号下应按折行撑高');
  assert.ok(t.footer.pageNumber.box.heightCm > t.footer.box.heightCm,
    '页码区比正文区窄，折行更多，高度应当更大');
}

// 撑开的文本框必须被正文边距让开 —— 它们是 wrapNone 浮动对象，Word 不会自动避让
for (const style of styles) {
  for (const size of ['小五', '小二', '初号']) {
    for (const [d, mt, mb] of [[1.75, 2, 2], [1, 2, 2], [0, 1.65, 1.65]]) {
      const { layout, textLayout } = buildChrome({
        ...page, header_footer_style: style, header_size: size, footer_size: size,
        footer_text: '某'.repeat(30), footer_distance_cm: d, margin_top_cm: mt, margin_bottom_cm: mb,
      });
      const where = `${style}/${size}/d=${d}`;
      const bodyTop = layout.marginTopCm;
      const bodyBottom = layout.heightCm - layout.marginBottomCm;
      for (const box of [textLayout.header.box, textLayout.header.badge?.box]) {
        if (box) assert.ok(box.topCm + box.heightCm <= bodyTop + 1e-9, `${where} 页眉文本框压住正文`);
      }
      for (const box of [textLayout.footer.box, textLayout.footer.pageNumber.box]) {
        if (box) assert.ok(box.topCm >= bodyBottom - 1e-9, `${where} 页脚文本框压住正文`);
      }
      assert.ok(layout.marginTopCm + layout.marginBottomCm < layout.heightCm, `${where} 正文区被压没了`);
    }
  }
}

// rules 把正文与页码合排在一个框里，估高必须按合排后的内容算
{
  const mk = (pn) => buildChrome({
    ...page, header_footer_style: 'rules', footer_size: '小五',
    footer_text: '某'.repeat(50), page_number_enabled: pn,
  }).textLayout.footer.box.heightCm;
  assert.ok(mk(true) > mk(false), 'rules 合排页码后应比只排正文更高');
}

// 关掉页码后两条链路都不渲染页码框，它就不该存在，也不该占正文边距
for (const style of styles) {
  const on = buildChrome({ ...page, header_footer_style: style, footer_size: '初号', footer_text: '投标' });
  const off = buildChrome({ ...page, header_footer_style: style, footer_size: '初号', footer_text: '投标', page_number_enabled: false });
  assert.equal(off.textLayout.footer.pageNumber.box, null, `${style} 关掉页码后仍留着页码框`);
  assert.ok(off.layout.marginBottomCm <= on.layout.marginBottomCm + 1e-9,
    `${style} 关掉页码后下边距反而更大`);
}

// 内容为空的框两端都不渲染，不能撑高，更不能挤占正文
for (const style of styles) {
  const { layout, textLayout } = buildChrome({
    ...page, header_footer_style: style, header_text: '', header_badge_text: '',
    header_size: '初号', footer_size: '初号', footer_enabled: false, page_number_enabled: false,
  });
  if (textLayout.header.box) {
    assert.ok(textLayout.header.box.heightCm <= 1.35 + 1e-9, `${style} 空页眉文字不该撑高文本框`);
  }
  assert.equal(layout.marginTopCm, 2, `${style} 空页眉不该抬高正文上边距`);
}

// ── 装饰带高度可配 ──────────────────────────────────────────────
// 六个新字段全为 null 时，几何必须与「压根没有这些字段」逐字节一致 ——
// 这是「老模板行为不变」的硬证据，也顺带保住上面那两条写死 360/567 与 1.35 的回归断言。
// 注意不能用 0 做这个探针：0 是合法的文字位置（footer-badge 的默认左沿就是 0），
// 表示「跟随默认」的是 null。
for (const style of styles) {
  const bare = buildChrome({ ...page, header_footer_style: style });
  const nulled = buildChrome({
    ...page, header_footer_style: style,
    header_chrome_height_cm: null, footer_chrome_height_cm: null,
    header_text_top_cm: null, header_text_left_cm: null,
    footer_text_top_cm: null, footer_text_left_cm: null,
  });
  assert.deepEqual(nulled.layout, bare.layout, `${style} 显式 null 改变了几何`);
  assert.deepEqual(nulled.textLayout, bare.textLayout, `${style} 显式 null 改变了文字层`);
}

// 具象化自洽：把「该样式的默认值」填回配置，结果必须与不填时一致。
// 这是新方案的根基 —— UI 打开模板就会把默认值写进 config，如果这里对不上，
// 用户什么都没改、导出却变了样。舍入到两位小数会引入 ≤0.005cm 的误差，按 0.01cm 容差判定。
for (const style of styles) {
  const bare = buildChrome({ ...page, header_footer_style: style });
  const filled = buildChrome({
    ...page, header_footer_style: style,
    ...resolveChromeGeometryDefaults({ ...page, header_footer_style: style }),
  });
  const near = (a, b, where) => assert.ok(Math.abs(a - b) < 0.01, `${where}：${a} vs ${b}`);
  near(filled.layout.headerHeightCm, bare.layout.headerHeightCm, `${style} 具象化改变了页眉带高`);
  near(filled.layout.footerHeightCm, bare.layout.footerHeightCm, `${style} 具象化改变了页脚带高`);
  for (const [label, a, b] of [
    ['页眉', bare.textLayout.header.box, filled.textLayout.header.box],
    ['页脚', bare.textLayout.footer.box, filled.textLayout.footer.box],
  ]) {
    if (!a || !b) continue;
    near(b.startCm, a.startCm, `${style} 具象化改变了${label}文字左沿`);
    near(b.topCm, a.topCm, `${style} 具象化改变了${label}文字上沿`);
  }
}

// plain 没有装饰带，配多高都不能凭空长出一条来
{
  const { layout, footerSvg, headerSvg } = buildChrome({
    ...page, header_footer_style: 'plain',
    header_chrome_height_cm: 2, footer_chrome_height_cm: 2,
  });
  assert.equal(layout.headerHeightCm, 0, 'plain 不该有页眉装饰带');
  assert.equal(layout.footerHeightCm, 0, 'plain 不该有页脚装饰带');
  assert.equal(headerSvg, null, 'plain 不该生成页眉装饰图');
  assert.equal(footerSvg, null, 'plain 不该生成页脚装饰图');
}

// 非 0 值被钳进安全区间；区间内的值原样返回
for (const style of styles.filter((s) => s !== 'plain')) {
  for (const [field, key, range] of [
    ['header_chrome_height_cm', 'headerHeightCm', HEADER_CHROME_HEIGHT_RANGE_CM],
    ['footer_chrome_height_cm', 'footerHeightCm', FOOTER_CHROME_HEIGHT_RANGE_CM],
  ]) {
    const at = (v) => buildChrome({ ...page, header_footer_style: style, [field]: v }).layout[key];
    assert.equal(at(0.01), range.min, `${style}/${field} 过小值没被钳到下限`);
    assert.equal(at(99), range.max, `${style}/${field} 过大值没被钳到上限`);
    const mid = (range.min + range.max) / 2;
    assert.equal(at(mid), mid, `${style}/${field} 区间内的值被改动了`);
  }
}

// 极端高度下所有不变式仍成立：文本框在纸内、不压正文、正文区没被压没
for (const style of styles) {
  for (const size of ['小五', '初号']) {
    for (const h of [null, 0.6, 0.8, 3, 99]) {
      const { layout, textLayout } = buildChrome({
        ...page, header_footer_style: style, header_size: size, footer_size: size,
        header_chrome_height_cm: h, footer_chrome_height_cm: h,
      });
      const where = `${style}/${size}/h=${h}`;
      const bodyTop = layout.marginTopCm;
      const bodyBottom = layout.heightCm - layout.marginBottomCm;
      for (const box of [textLayout.header.box, textLayout.header.badge?.box]) {
        if (!box) continue;
        assert.ok(box.endCm > box.startCm, `${where} 页眉文本框宽度非正`);
        assert.ok(box.topCm >= -1e-9, `${where} 页眉文本框越过纸张上边`);
        assert.ok(box.topCm + box.heightCm <= bodyTop + 1e-9, `${where} 页眉文本框压住正文`);
      }
      for (const box of [textLayout.footer.box, textLayout.footer.pageNumber.box]) {
        if (!box) continue;
        assert.ok(box.endCm > box.startCm, `${where} 页脚文本框宽度非正`);
        assert.ok(box.topCm + box.heightCm <= layout.heightCm + 1e-9, `${where} 页脚文本框越过纸张下边`);
        assert.ok(box.topCm >= bodyBottom - 1e-9, `${where} 页脚文本框压住正文`);
      }
      assert.ok(layout.marginTopCm + layout.marginBottomCm < layout.heightCm, `${where} 正文区被压没了`);
    }
  }
}

// 装饰图不能出现负的 width/height —— 负尺寸属性会让整个 <rect> 被丢弃，
// 图案缺一块却不报错，是高度可配之后最容易静默回归的点。
// （负的 x/y 是 slant/top-bar 刻意的出血设计，不在此列。）
{
  const negative = /\b(width|height)="-[\d.]/;
  for (const style of styles) {
    for (const h of [null, 0.6, 0.8, 1.35, 3, 99]) {
      const { headerSvg, footerSvg, layout } = buildChrome({
        ...page, header_footer_style: style,
        header_chrome_height_cm: h, footer_chrome_height_cm: h,
      });
      const where = `${style}/h=${h}`;
      assert.ok(!negative.test(headerSvg || ''), `${where} 页眉装饰出现负尺寸`);
      assert.ok(!negative.test(footerSvg || ''), `${where} 页脚装饰出现负尺寸`);
      if (footerSvg) {
        assert.ok(footerSvg.includes(`viewBox="0 0 ${n(cmToSvg(layout.widthCm))} ${n(cmToSvg(layout.footerHeightCm))}"`),
          `${where} 页脚装饰的 viewBox 与几何不一致`);
      }
    }
  }
}

// ── 文字位置（绝对值） ────────────────────────────────────────
for (const style of styles.filter((s) => s !== 'plain')) {
  const cfg = { ...page, header_footer_style: style };
  const def = resolveChromeGeometryDefaults(cfg);
  const placed = buildChrome({
    ...cfg,
    header_text_left_cm: 3, header_text_top_cm: 0.2,
    footer_text_left_cm: 3, footer_text_top_cm: 0.1,
  });
  const { layout: L, textLayout: T } = placed;

  // 填什么就落在哪 —— 这是「显示值即真实值」的根本前提，破了用户就再也不能相信输入框
  if (T.header.box) {
    assert.ok(Math.abs(T.header.box.startCm - 3) < 1e-9, `${style} 页眉文字左沿没落在指定位置`);
    assert.ok(Math.abs(T.header.box.topCm - 0.2) < 1e-9, `${style} 页眉文字上沿没落在指定位置`);
  }
  if (T.footer.box) {
    assert.ok(Math.abs(T.footer.box.startCm - 3) < 1e-9, `${style} 页脚文字左沿没落在指定位置`);
    // 页脚的 top 相对装饰带上沿，换算回纸张坐标才能比
    assert.ok(Math.abs((T.footer.box.topCm - L.footerTopCm) - 0.1) < 1e-9,
      `${style} 页脚文字上沿没落在指定位置`);
  }

  // 右沿属于装饰结构（band 的徽标格、frame 的双线框），不跟着左沿跑
  const bare = buildChrome(cfg).textLayout;
  for (const [label, a, b] of [
    ['页眉', bare.header.box, T.header.box],
    ['页脚', bare.footer.box, T.footer.box],
  ]) {
    if (!a || !b) continue;
    assert.ok(Math.abs(b.endCm - a.endCm) < 1e-9, `${style} ${label}文字右沿不该跟着左沿移动`);
    assert.ok(b.endCm > b.startCm, `${style} ${label}文本框宽度非正`);
  }

  // 徽标压在实色块上、页码格右锚定，两者都只跟 top 不跟 left
  if (bare.header.badge?.box && T.header.badge?.box) {
    assert.equal(T.header.badge.box.startCm, bare.header.badge.box.startCm,
      `${style} 徽标不该跟随左边距（会脱离色块）`);
    assert.ok(Math.abs(T.header.badge.box.topCm - 0.2) < 1e-9, `${style} 徽标该跟随上边距`);
  }
  if (bare.footer.pageNumber.box && T.footer.pageNumber.box) {
    assert.equal(T.footer.pageNumber.box.startCm, bare.footer.pageNumber.box.startCm,
      `${style} 页码不该跟随左边距（会脱格）`);
  }

  // 默认值原样填回 = 不填
  assert.ok(def.header_text_left_cm >= 0 && def.footer_text_left_cm >= 0,
    `${style} 默认左边距不该为负`);
}

// 文字框不溢出装饰带：top 推大时高度要跟着收，否则文字会掉到色带外面
for (const style of styles.filter((s) => s !== 'plain')) {
  for (const top of [0, 0.3, 0.8, 99]) {
    const { layout: L, textLayout: T } = buildChrome({
      ...page, header_footer_style: style,
      header_text_top_cm: top, footer_text_top_cm: top,
    });
    const where = `${style}/top=${top}`;
    if (T.header.box && L.headerHeightCm > 0) {
      assert.ok(T.header.box.topCm >= -1e-9, `${where} 页眉文字越过纸张上边`);
      // fitTextBox 撑高后可以超出装饰带（文字装不下就得溢出），但起点必须还在带内
      assert.ok(T.header.box.topCm <= L.headerHeightCm + 1e-9, `${where} 页眉文字起点掉出装饰带`);
    }
    if (T.footer.box && L.footerHeightCm > 0) {
      const rel = T.footer.box.topCm - L.footerTopCm;
      assert.ok(rel >= -1e-9, `${where} 页脚文字起点在装饰带上方`);
      assert.ok(rel <= L.footerHeightCm + 1e-9, `${where} 页脚文字起点掉出装饰带`);
    }
    assert.ok(L.marginTopCm + L.marginBottomCm < L.heightCm, `${where} 正文区被压没了`);
  }
}

// 极端左边距下框仍然可用
for (const style of styles.filter((s) => s !== 'plain')) {
  for (const left of [0, 19, 99]) {
    const { layout: L, textLayout: T } = buildChrome({
      ...page, header_footer_style: style, header_text_left_cm: left, footer_text_left_cm: left,
    });
    for (const [label, box] of [['页眉', T.header.box], ['页脚', T.footer.box]]) {
      if (!box) continue;
      assert.ok(box.startCm >= -1e-9 && box.endCm <= L.widthCm + 1e-9,
        `${style}/left=${left} ${label}文本框越出纸张左右`);
      assert.ok(box.endCm - box.startCm > 0, `${style}/left=${left} ${label}文本框宽度非正`);
    }
  }
}

console.log('布局断言 OK');
