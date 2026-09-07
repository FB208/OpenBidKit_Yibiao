// 运行：node scripts/check-chrome-layout.mjs
import assert from 'node:assert/strict';
import { buildChrome, formatPageNumber } from '../electron/shared/chrome/index.mjs';

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

console.log('布局断言 OK');
