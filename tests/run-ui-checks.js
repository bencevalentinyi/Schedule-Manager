/**
 * Static checks of the HTML user interface. No browser needed.
 *
 * For every page in src/*.html (with its includes):
 *  - every include('X') exists, and full pages include Styles and ClientCore;
 *  - all <script> code compiles (syntax);
 *  - every inline handler (onclick, onchange, …) calls functions that the page defines;
 *  - every google.script.run / api() / call() target is a top-level function in a .gs file;
 *  - every element id used by $('…'), show('…'), fieldError('…') … exists in the page;
 *  - every <label for> points to an existing id; static form controls have a label;
 *  - every static <button> has type="button" and an accessible name; no duplicate static ids;
 *  - every full page has an id="status" area for errors.
 * Also: every menu item in onOpen calls an existing function, and every page opened by
 * showHtml_ exists.
 *
 * Usage:  node tests/run-ui-checks.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const htmlFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).sort();
const gsText = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map(read).join('\n');
const serverFns = new Set([...gsText.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));

const ALLOWED_ROOTS = new Set(['if', 'for', 'return', 'function', 'event', 'this', 'String', 'Number', 'Math', 'JSON', 'google', 'document', 'window', 'Array']);
let failures = 0, checks = 0;
const fail = (file, msg) => { failures++; console.log('  FAIL ' + file + ': ' + msg); };
const ok = () => { checks++; };

function includesOf(text) { return [...text.matchAll(/<\?!=\s*include\('([^']+)'\)\s*\?>/g)].map((m) => m[1]); }
function scriptsOf(text) { return [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }
function staticMarkup(text) { return text.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, ''); }

htmlFiles.forEach((file) => {
  const own = read(file);
  const isPage = /<!DOCTYPE html>/i.test(own);
  const incs = includesOf(own);
  incs.forEach((i) => { if (!fs.existsSync(path.join(SRC, i + '.html'))) fail(file, 'include("' + i + '") has no file ' + i + '.html'); else ok(); });
  if (!isPage) return; // partials are checked through the pages that include them
  ['Styles', 'ClientCore'].forEach((i) => { if (incs.indexOf(i) < 0) fail(file, 'does not include ' + i); else ok(); });
  const all = [own].concat(incs.filter((i) => fs.existsSync(path.join(SRC, i + '.html'))).map((i) => read(i + '.html'))).join('\n');

  // 1. Script syntax
  const code = [own].concat(incs.map((i) => read(i + '.html'))).map(scriptsOf).flat().join('\n;\n').replace(/<\?!=\s*bootJson\s*\?>/g, '{}');
  try { new vm.Script(code, { filename: file }); ok(); } catch (e) { fail(file, 'script does not compile: ' + e.message); }

  // 2. Inline handlers call defined functions
  const defined = new Set([...all.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
    .concat([...all.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function/g)].map((m) => m[1])));
  [...all.matchAll(/\bon(?:click|change|input|keydown|search|submit)="([^"]*)"/g)].forEach((m) => {
    [...m[1].matchAll(/([A-Za-z_$][\w$]*)(?:\.[\w$]+)*\s*\(/g)].forEach((c) => {
      const root = c[1];
      if (ALLOWED_ROOTS.has(root) || defined.has(root)) ok();
      else fail(file, 'handler "' + m[1] + '" calls undefined function ' + root + '()');
    });
  });

  // 3. Server calls exist
  const targets = new Set([...all.matchAll(/['"]((?:api|menu)[A-Z]\w*)['"]/g)].map((m) => m[1])
    .concat([...all.matchAll(/\.\s*((?:api|menu)[A-Z]\w*)\s*\(/g)].map((m) => m[1])));
  targets.forEach((t) => { if (serverFns.has(t)) ok(); else fail(file, 'calls server function ' + t + ' which is not defined in any .gs file'); });

  // 4. Element ids referenced by helpers exist
  const ids = new Set([...all.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]).concat([...all.matchAll(/\.id\s*=\s*'([A-Za-z][\w-]*)'/g)].map((m) => m[1])));
  // (?<![\w$]) instead of \b: "\b" never matches before "$".
  const refRe = /(?<![\w$])(?:\$|show|fieldError|focusFirst|renderStepper|initTabs|selectTab|askConfirm|closeConfirm|getElementById)\(\s*'([A-Za-z][\w-]*)'\s*[,)]/g;
  new Set([...all.matchAll(refRe)].map((m) => m[1])).forEach((id) => { if (ids.has(id)) ok(); else fail(file, 'references element #' + id + ' which does not exist'); });
  if (ids.has('status')) ok(); else fail(file, 'has no id="status" area for errors');

  // 5. Static markup: labels, controls, buttons, duplicate ids
  const markup = staticMarkup(own);
  const staticIds = [...markup.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]);
  const dup = staticIds.filter((x, i) => staticIds.indexOf(x) !== i);
  if (dup.length) fail(file, 'duplicate ids: ' + [...new Set(dup)].join(', ')); else ok();
  [...markup.matchAll(/\bfor="([A-Za-z][\w-]*)"/g)].forEach((m) => { if (ids.has(m[1])) ok(); else fail(file, '<label for="' + m[1] + '"> points to a missing id'); });
  const labelSpans = [...markup.matchAll(/<label\b[\s\S]*?<\/label>/g)].map((m) => [m.index, m.index + m[0].length]);
  const insideLabel = (i) => labelSpans.some((s) => i > s[0] && i < s[1]);
  [...markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].forEach((m) => {
    const attrs = m[2];
    if (/type="hidden"/.test(attrs) || /aria-hidden="true"/.test(attrs)) return;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    const labelled = /aria-label(ledby)?=/.test(attrs) || insideLabel(m.index) || (id && new RegExp('for="' + id + '"').test(markup));
    if (labelled) ok(); else fail(file, '<' + m[1] + (id ? ' id="' + id + '"' : '') + '> has no label');
  });
  [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].forEach((m) => {
    if (!/type="button"/.test(m[1])) fail(file, 'button without type="button": ' + m[0].slice(0, 80)); else ok();
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text || /aria-label=/.test(m[1])) ok(); else fail(file, 'button without an accessible name: ' + m[0].slice(0, 80));
  });
});

// Menu items and dialog files
const main = read('Main.gs');
[...main.matchAll(/\.addItem\('[^']*',\s*'([\w$]+)'\)/g)].forEach((m) => { if (serverFns.has(m[1])) ok(); else fail('Main.gs', 'menu item calls missing function ' + m[1]); });
[...gsText.matchAll(/showHtml_\('(\w+)'/g)].forEach((m) => { if (fs.existsSync(path.join(SRC, m[1] + '.html'))) ok(); else fail('Main.gs', 'showHtml_ opens missing page ' + m[1]); });

console.log((failures ? '  FAIL ' : '  PASS ') + 'UI static checks: ' + checks + ' passed, ' + failures + ' failed (' + htmlFiles.length + ' HTML files)');
process.exit(failures ? 1 : 0);
