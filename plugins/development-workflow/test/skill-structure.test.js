'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkSkillStructure } = require('../skills/dw-tooling/scripts/check-skill-structure.js');
const catalogPath = 'skills/dw-tooling/references/automation-coverage.json';

function coverageEntry(overrides = {}) {
  return { path: 'hooks/session-start.js', owner: 'dw-writing', enforcement: 'advisory',
    tests: ['test/sample.test.js'], limits: 'Fixture only; no host acceptance.', ...overrides };
}

function catalog(entries = [coverageEntry()]) {
  return { schemaVersion: 1, scope: 'Source inventory and test references, not execution evidence.', entries };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-structure-'));
  const put = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('package.json', { files: ['skills/', 'hooks/', 'rules/', 'test/'] });
  put('skills/development-workflow/SKILL.md', '---\nname: development-workflow\ndescription: Use when coordinating work.\n---\n[Writing](../dw-writing/SKILL.md)\n');
  put('skills/dw-writing/SKILL.md', '---\nname: dw-writing\ndescription: Use when writing.\n---\n[Hub](../development-workflow/SKILL.md)\n');
  put('hooks/hooks.json', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js"' }] }] } });
  put('hooks/session-start.js', "'use strict';\n");
  put('test/sample.test.js', "'use strict';\n");
  put('test/test-manifest.json', { suites: { all: { tests: [{ name: 'sample', command: 'node', args: ['test/sample.test.js'] }] } } });
  put(catalogPath, catalog());
  const options = {
    pluginRoot: root,
    skillIds: ['development-workflow', 'dw-writing'],
    routes: [{ id: 'writing', skills: ['dw-writing'], context: 'Use development-workflow:dw-writing.' }],
  };
  return { root, put, options };
}

const cases = [
  ['accepts valid structure without modifying files', ({ root, options }) => {
    const before = fs.readFileSync(path.join(root, 'skills/dw-writing/SKILL.md'));
    const result = checkSkillStructure(options);
    assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
    assert.deepStrictEqual(result.skills, ['development-workflow', 'dw-writing']);
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'skills/dw-writing/SKILL.md')), before);
  }],
  ['finds an unregistered test even when manifest is internally consistent', ({ put, options }) => {
    put('test/forgotten.test.js', "'use strict';\n");
    const result = checkSkillStructure(options);
    assert(result.issues.some(issue => issue.code === 'TEST_NOT_REGISTERED' && issue.file === 'test/forgotten.test.js'));
  }],
  ['rejects missing or out-of-root local links and accepts external URLs', ({ put, options }) => {
    put('rules/example.md', '[missing](../skills/missing/SKILL.md#usage)\n[escape](../../outside.md)\n[web](https://example.com/guide.md)\n');
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'LINK_MISSING'));
    assert(issues.some(issue => issue.code === 'LINK_OUTSIDE_PLUGIN'));
    assert.strictEqual(issues.filter(issue => issue.code.startsWith('LINK_')).length, 2);
  }],
  ['requires router references and registered skill IDs to name shipped skills', ({ options }) => {
    options.skillIds.push('dw-missing');
    options.routes.push({ id: 'missing', skills: ['dw-missing'], context: 'Use development-workflow:dw-missing.' });
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'REGISTERED_SKILL_MISSING'));
    assert(issues.some(issue => issue.code === 'ROUTE_TARGET_MISSING'));
  }],
  ['rejects route prose that names a target absent from its declared skills', ({ options }) => {
    options.routes[0].context = 'Use development-workflow:development-workflow.';
    assert(checkSkillStructure(options).issues.some(issue => issue.code === 'ROUTE_TARGET_MISMATCH'));
  }],
  ['detects omitted skill and hook assets in the declared package files', ({ put, options }) => {
    put('package.json', { files: ['skills/development-workflow/', 'test/'] });
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'ASSET_NOT_PACKAGED' && issue.file === 'skills/dw-writing/SKILL.md'));
    assert(issues.some(issue => issue.code === 'ASSET_NOT_PACKAGED' && issue.file === 'hooks/session-start.js'));
  }],
  ['requires a linked skill reference to be included in the package', ({ put, options }) => {
    put('skills/dw-writing/SKILL.md', '---\nname: dw-writing\ndescription: Use when writing.\n---\n[Guide](references/progress.md)\n');
    put('skills/dw-writing/references/progress.md', 'Report observed progress.\n');
    put('package.json', { files: ['skills/development-workflow/', 'skills/dw-writing/SKILL.md', 'hooks/', 'rules/', 'test/'] });
    assert(checkSkillStructure(options).issues.some(issue => issue.code === 'ASSET_NOT_PACKAGED' && issue.file === 'skills/dw-writing/references/progress.md'));
    put('package.json', { files: ['skills/', 'hooks/', 'rules/', 'test/'] });
    assert.strictEqual(checkSkillStructure(options).ok, true);
  }],
  ['detects stale names, missing navigation and missing registered hooks', ({ put, options, root }) => {
    put('skills/dw-writing/SKILL.md', '---\nname: wrong-name\ndescription: Use when writing.\n---\n');
    put('skills/development-workflow/SKILL.md', '---\nname: development-workflow\ndescription: Use when coordinating work.\n---\n');
    fs.unlinkSync(path.join(root, 'hooks/session-start.js'));
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'SKILL_NAME_MISMATCH'));
    assert(issues.some(issue => issue.code === 'SKILL_NOT_IN_HUB'));
    assert(issues.some(issue => issue.code === 'HOOK_MISSING'));
  }],
  ['reports malformed metadata as a validation failure', ({ put, options }) => {
    put('test/test-manifest.json', '{broken json');
    assert(checkSkillStructure(options).issues.some(issue => issue.code === 'JSON_INVALID'));
  }],
  ['requires the coverage catalog and an entry for every production source', ({ put, options, root }) => {
    fs.unlinkSync(path.join(root, catalogPath));
    assert(checkSkillStructure(options).issues.some(issue => issue.code === 'FILE_UNREADABLE' && issue.file === catalogPath));
    put(catalogPath, catalog());
    for (const file of ['skills/dw-writing/scripts/new.js', 'skills/dw-writing/scripts/native/New.cs', 'hooks/new.py']) {
      put(file, '// unclassified source');
    }
    const result = checkSkillStructure(options);
    assert.strictEqual(result.scripts.length, 2);
    assert.strictEqual(result.runtimeSources.length, 4);
    assert.strictEqual(result.issues.filter(issue => issue.code === 'SOURCE_NOT_CATALOGED').length, 3);
  }],
  ['rejects duplicate and dangling source paths', ({ put, options }) => {
    put(catalogPath, catalog([coverageEntry(), coverageEntry(), coverageEntry({ path: 'hooks/missing.js' })]));
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'COVERAGE_SOURCE_DUPLICATE'));
    assert(issues.some(issue => issue.code === 'COVERAGE_SOURCE_MISSING'));
  }],
  ['requires a shipped owner and existing registered tests', ({ put, options }) => {
    put('test/unregistered.test.js', "'use strict';\n");
    put(catalogPath, catalog([coverageEntry({ owner: 'dw-missing', tests: ['test/missing.test.js', 'test/unregistered.test.js'] })]));
    const issues = checkSkillStructure(options).issues;
    assert(issues.some(issue => issue.code === 'COVERAGE_OWNER_MISSING'));
    assert(issues.some(issue => issue.code === 'COVERAGE_TEST_MISSING'));
    assert(issues.some(issue => issue.code === 'COVERAGE_TEST_NOT_REGISTERED'));
  }],
  ['reports invalid catalog values without crashing', ({ put, options }) => {
    for (const value of ['{invalid', 'null', '[]', '42', '{"schemaVersion":1,"entries":{}}',
      JSON.stringify(catalog([null, 42, [], {}, coverageEntry({ path: '../outside.js' }),
        coverageEntry({ enforcement: 'always-run', tests: [null], limits: '' }),
        coverageEntry({ owner: { toString: null, valueOf: null } })]))]) {
      put(catalogPath, value);
      let result;
      assert.doesNotThrow(() => { result = checkSkillStructure(options); });
      assert.strictEqual(result.ok, false, value);
      assert(result.issues.some(issue => ['JSON_INVALID', 'COVERAGE_CATALOG_INVALID', 'COVERAGE_ENTRY_INVALID'].includes(issue.code)), value);
    }
  }],
  ['requires native production sources to be packaged', ({ put, options }) => {
    const source = 'skills/dw-writing/scripts/native/Helper.cs';
    put(source, 'class Helper {}');
    put(catalogPath, catalog([coverageEntry(), coverageEntry({ path: source, enforcement: 'opt-in-runtime' })]));
    put('package.json', { files: ['skills/development-workflow/', 'skills/dw-writing/SKILL.md', 'skills/dw-tooling/references/', 'hooks/', 'test/'] });
    const result = checkSkillStructure(options);
    assert(result.runtimeSources.includes(source));
    assert(result.issues.some(issue => issue.code === 'ASSET_NOT_PACKAGED' && issue.file === source));
  }],
];

for (const [name, run] of cases) {
  const data = fixture();
  try {
    run(data);
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}\n${error.stack}`);
    process.exitCode = 1;
  } finally {
    // This randomly named fixture is created and used only by this test process.
    fs.rmSync(data.root, { recursive: true, force: true });
  }
}

const current = checkSkillStructure();
if (!current.ok) {
  console.error(JSON.stringify(current.issues, null, 2));
  process.exitCode = 1;
} else {
  assert.strictEqual(current.scripts.length, 28, 'Inventory includes command dispatch, platform clients and todo-plan CLI');
  assert.strictEqual(current.runtimeSources.length, 32, 'Inventory includes Windows native, POSIX supervisor, todo-plan and file-governance sources');
  console.log('ok - current plugin has no missing skills, references, route targets or test registrations');
}
if (!process.exitCode) console.log(`${cases.length + 1}/${cases.length + 1} skill structure tests passed`);
