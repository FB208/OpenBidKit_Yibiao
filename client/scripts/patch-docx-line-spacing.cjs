const fs = require('node:fs');
const path = require('node:path');

// Scope: generated template DOCX files have no w:docGrid (CreateSectionProperties).
// Resolve OOXML line units in semantic layout, never from CSS or measured text height.
// LibreOffice DomainMapper::lcl_attribute defines nSingleLineSpacing = 240 twips and
// imports beforeLines/afterLines as value * nSingleLineSpacing / 100:
// https://github.com/LibreOffice/core/blob/master/sw/source/writerfilter/dmapper/DomainMapper.cxx
// Word calls LineUnitBefore spacing "in gridlines", not paragraph line-box heights:
// https://learn.microsoft.com/en-us/office/vba/api/word.paragraphformat.lineunitbefore
// This is the standard-line import convention, NOT support for custom docGrid linePitch.
// ECMA-376 spacing: auto > line units > twips; attributes cascade independently.
// https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_spacing_topic_ID0EA1OM.html

const corePath = path.resolve(__dirname, '../node_modules/@docx-editor.dev/core');
const { version } = JSON.parse(fs.readFileSync(path.join(corePath, 'package.json'), 'utf8'));
if (version !== '2.15.0') {
  throw new Error(`DOCX line-spacing patch requires core 2.15.0, received ${version}.`);
}

// Build the same semantic resolver for the package's ESM and CommonJS entry points.
function paragraphSpacingPatch(name, points, isOn, autoSpacing) {
  const before = `function ${name}(e,t){let n=0,r=0,o=false,a=false;for(let i of e){if(i.localName!=="spacing")continue;let s=i.attributes?.before,l=i.attributes?.after;s!==void 0&&(n=${points}(s)),l!==void 0&&(r=${points}(l));let d=i.attributes?.beforeAutospacing,c=i.attributes?.afterAutospacing;d!==void 0&&(o=${isOn}(d)),c!==void 0&&(a=${isOn}(c));}if(o||a){let i=t?.inList||t?.inTableCell?0:${autoSpacing};o&&(n=i),a&&(r=i);}return {before:n,after:r}}`;
  const after = `function ${name}(props, context) {
  // yibiao: standard-line OOXML paragraph spacing, core 2.15.0.
  const attributes = {};
  for (const property of props) {
    if (property.localName === "spacing") {
      Object.assign(attributes, property.attributes);
    }
  }
  const spacing = {
    before: ${points}(attributes.before),
    after: ${points}(attributes.after)
  };
  for (const side of ["before", "after"]) {
    const raw = attributes[side + "Lines"];
    if (raw !== undefined) {
      // Match core's integer parsing and paragraph-spacing bound (31680 twips).
      // One standard line = 240 twips; the XML value is hundredths of that unit.
      const count = /^-?\\d{1,9}$/.test(raw) ? Number(raw) : 0;
      spacing[side] = Math.min(31680 / 20, Math.max(0, count * 240 / 100 / 20));
    }
    const auto = attributes[side + "Autospacing"];
    if (auto !== undefined && ${isOn}(auto)) {
      spacing[side] = context?.inList || context?.inTableCell ? 0 : ${autoSpacing};
    }
  }
  return spacing;
}`;
  return { before, after };
}

// Prepare both replacements before writing; a changed upstream bundle must fail installation.
const replacements = [
  ['chunk-RJSB6RJ7.js', 'pf', 'Jh', 'Xl', 'tb'],
  ['chunk-AVGCKH6A.cjs', 'yf', 'nb', 'ql', 'ab'],
].map(([file, ...symbols]) => {
  const filePath = path.join(corePath, 'dist', file);
  const source = fs.readFileSync(filePath, 'utf8');
  const { before, after } = paragraphSpacingPatch(...symbols);
  if (source.includes(after)) return null;
  const start = source.indexOf(before);
  if (start === -1 || source.indexOf(before, start + before.length) !== -1) {
    throw new Error(`DOCX line-spacing patch cannot locate the original resolver in ${file}.`);
  }
  return { filePath, source: source.replace(before, after) };
});

for (const replacement of replacements) {
  if (replacement) fs.writeFileSync(replacement.filePath, replacement.source, 'utf8');
}
console.log('DOCX standard-line paragraph spacing patch applied (core 2.15.0).');
