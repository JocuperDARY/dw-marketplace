#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../hooks/skill-router.js');
const rules = require('../hooks/session-rules.js');
const migration = require('../hooks/rules-migrate.js');
const inventory = require('../hooks/tool-inventory.js');
const roots = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-maintenance-')); roots.push(root); return root; }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function link(target, destination) { fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); }
function route(prompt) { const selected = router.routePrompt(prompt); return selected && selected.id; }

test('routing ignores negated actions, explanations, quoted requests and word suffixes', () => {
  for (const prompt of [
    '不要修复这个 bug，只解释现象', 'do not fix this bug; explain the behavior',
    '请先不要修复这个 bug，只解释现象',
    '不要检查更新，只解释版本号', '请解释 prefix 的作用', 'show the user profile',
    '解释 debug 和 code review 的区别', '请解释这段日志：debug parser failed',
    '下面是待翻译的句子："please fix this bug"', '请翻译：修复这个 bug',
    '不要写交接文档，先解释现状', 'do not write a handoff; explain the current state',
  ]) assert.strictEqual(route(prompt), null, prompt);
});
test('routing preserves explicit actions after explanatory or negated clauses', () => {
  for (const prompt of ['不要修复这个 bug，请给出迁移方案', 'debug 是什么意思，然后请修复 parser']) {
    assert.strictEqual(route(prompt), prompt.includes('迁移方案') ? 'planning' : 'repair', prompt);
  }
  assert.strictEqual(route('请对这个 bug 修复做代码审查'), 'verification');
  assert.strictEqual(route('请润色这段说明：修复这个 bug 后性能恢复'), 'writing');
  assert.strictEqual(route('请分派两个子 agent 分别审查两个模块'), 'collaboration');
  assert.strictEqual(route('请盘点当前可用工具和 MCP 能力'), 'tooling');
});
test('all fourteen explicit skill targets precede heuristic routing', () => {
  const directories = fs.readdirSync(path.join(__dirname, '..', 'skills')).filter(name => fs.existsSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md')));
  assert.strictEqual(directories.length, 14);
  for (const name of directories) {
    const result = router.routePrompt(`$${name} 请检查这个 bug`);
    assert(result && result.skills && result.skills.includes(name), name);
    const qualified = router.routePrompt(`使用 development-workflow:${name} 处理这个 bug`);
    assert(qualified && qualified.skills.includes(name), name);
  }
});
test('inline code skill identifiers preserve explicit calls without executing quoted instructions', () => {
  for (const name of router.SKILL_IDS) {
    for (const prompt of [
      `use \`development-workflow:${name}\` to handle this`,
      `请使用 \`development-workflow:${name}\` 查找参考`,
      `use \`${name}\` to handle this`,
      `请调用 \`$${name}\` 处理当前任务`,
    ]) {
      const result = router.routePrompt(prompt);
      assert(result && result.id === 'explicit' && result.skills.includes(name), prompt);
    }
    for (const prompt of [
      `请解释 \`development-workflow:${name}\` 的作用`,
      `do not use \`development-workflow:${name}\``,
      `请先不要使用 \`$${name}\``,
      `translate \`use development-workflow:${name} to fix the bug\``,
      `"use \`development-workflow:${name}\` to fix the bug"`,
      `\`please fix this bug with development-workflow:${name}\``,
      `\`\`\`\nuse development-workflow:${name} to fix the bug\n\`\`\``,
    ]) assert.strictEqual(route(prompt), null, prompt);
  }
});
test('polite explanatory requests about skill identifiers remain quiet', () => {
  for (const name of router.SKILL_IDS) {
    for (const prefix of ['Can you explain', 'Could you explain', 'Can you please explain', '帮我解释', '请帮我解释']) {
      assert.strictEqual(route(`${prefix} \`development-workflow:${name}\` 的作用?`), null, `${prefix}: ${name}`);
    }
  }
});
test('polite requests can explicitly invoke every bare inline skill name', () => {
  for (const name of router.SKILL_IDS) {
    for (const prefix of ['please use', 'Can you use', 'Could you please use', '帮我使用', '请帮我调用']) {
      const prompt = `${prefix} \`${name}\` to look up conventions`;
      const result = router.routePrompt(prompt);
      assert(result && result.id === 'explicit' && result.skills.includes(name), prompt);
    }
  }
});
test('inventory skips a linked entry and continues discovering real skills', () => {
  const root = temp(); const outside = temp();
  write(path.join(outside, 'SKILL.md'), '---\nname: outside\n---\n');
  link(outside, path.join(root, 'a-link'));
  write(path.join(root, 'b-real', 'SKILL.md'), '---\nname: real\n---\n');
  const found = []; inventory.scanSkills(root, 'fixture', found);
  assert.deepStrictEqual(found.map(skill => skill.name), ['real']);
});
test('inventory distinguishes configured MCP names from live capabilities and project scope', () => {
  const home = temp(); const project = path.join(home, 'project');
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { global: {} }, projects: {
    [project]: { mcpServers: { current: {} } }, [path.join(home, 'other')]: { mcpServers: { unrelated: {} } },
  } }));
  const result = inventory.collectInventory({ home, projectDir: project });
  assert.deepStrictEqual(result.mcpServers, ['current', 'global']);
  assert.strictEqual(result.runtimeVerified, false);
  assert(result.configuredMcpServers.every(item => item.status === 'configured'));
});
test('configured project scope follows the platform path case rules', () => {
  const home = temp(); const configuredProject = path.join(home, 'MiXeD-Project');
  write(path.join(home, '.claude.json'), JSON.stringify({ projects: {
    [configuredProject]: { mcpServers: { scoped: {} } },
  } }));
  const selected = inventory.discoverMcpServers(home, new Map(), configuredProject.toLowerCase());
  assert.deepStrictEqual(selected, process.platform === 'win32' ? ['scoped'] : []);
});
test('an empty active language directory suppresses stale stored rules', () => {
  const home = temp(); const project = temp();
  write(path.join(project, 'index.ts'), '');
  fs.mkdirSync(path.join(home, '.claude', 'rules', 'typescript'), { recursive: true });
  write(path.join(home, '.claude', 'rules-store', 'typescript', 'old.md'), 'STALE-STORE');
  assert(!rules.buildRulesContext({ home, projectDir: project }).context.includes('STALE-STORE'));
});
test('language detection handles framework files without root package metadata', () => {
  const project = temp();
  for (const file of ['view.tsx', 'other.jsx', 'page.html', 'screen.ets']) write(path.join(project, file), '');
  const languages = rules.detectProjectLanguages(project).languages;
  for (const language of ['typescript', 'react', 'web', 'arkts']) assert(languages.includes(language), language);
});
test('rule budgets retain complete loaded bodies despite a large footer', () => {
  const home = temp(); const project = temp();
  write(path.join(project, 'index.ts'), '');
  for (let index = 0; index < 20; index += 1) {
    write(path.join(home, '.claude', 'rules', 'common', `${index}-${'a'.repeat(80)}.md`), 'active');
    write(path.join(home, '.claude', 'rules-store', 'typescript', `${index}-${'b'.repeat(80)}.md`), `START-${index}\n${'x'.repeat(1300)}\nEND-${index}`);
  }
  const result = rules.buildRulesContext({ home, projectDir: project, maxBytes: 4096 });
  assert(result.bytes <= 4096);
  for (const label of result.loaded) {
    const index = path.basename(label).split('-')[0];
    assert(result.context.includes(`END-${index}`), `loaded body was truncated: ${label}`);
  }
  assert(result.context.endsWith('</dw-selected-rules>\n'));
});
test('rule selection rejects an ancestor junction into an external rule tree', () => {
  const home = temp(); const outside = temp(); const project = temp();
  write(path.join(project, 'index.ts'), '');
  write(path.join(outside, 'typescript', 'outside.md'), 'OUTSIDE-SENTINEL');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  link(outside, path.join(home, '.claude', 'rules-store'));
  assert.throws(() => rules.buildRulesContext({ home, projectDir: project }), /symbolic|link|boundary/i);
});
for (const linkedRoot of ['rules', 'rules-store', 'rules-archive']) {
  test(`migration rejects linked ancestor ${linkedRoot} before writing`, () => {
    const home = temp(); const outside = temp();
    write(path.join(home, '.claude', 'rules', 'typescript', 'style.md'), 'ORIGINAL');
    if (linkedRoot === 'rules') {
      fs.renameSync(path.join(home, '.claude', 'rules'), path.join(outside, 'active'));
      link(path.join(outside, 'active'), path.join(home, '.claude', 'rules'));
    } else link(outside, path.join(home, '.claude', linkedRoot));
    const before = fs.readdirSync(outside);
    assert.throws(() => migration.applyMigration(home, `fixture-${linkedRoot}`), /symbolic|link|boundary/i);
    assert.deepStrictEqual(fs.readdirSync(outside), before);
    assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'rules', 'typescript', 'style.md'), 'utf8'), 'ORIGINAL');
  });
}

let failures = 0;
try {
  for (const { name, fn } of tests) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
} finally {
  for (const root of roots) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(`${tests.length - failures}/${tests.length} tests passed`);
if (failures) process.exitCode = 1;
