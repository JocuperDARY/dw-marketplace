'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const skillPath = path.join(pluginRoot, 'skills', 'dw-collaboration', 'SKILL.md');

assert(
  fs.existsSync(skillPath),
  'RED: canonical dw-collaboration Skill is absent from the 5.0.0 baseline',
);

const scenarios = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'collaboration', 'pressure-scenarios.json'),
  'utf8',
));
const skill = fs.readFileSync(skillPath, 'utf8');
for (const scenario of scenarios.scenarios) {
  assert(
    skill.includes(scenario.expected),
    `behavior contract missing safe decision vocabulary for ${scenario.id}`,
  );
}

console.log('collaboration behavior contract passed');
