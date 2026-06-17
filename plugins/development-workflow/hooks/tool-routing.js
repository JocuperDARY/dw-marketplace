#!/usr/bin/env node
'use strict';
try{const fs=require('fs'),path=require('path');
let input='';if(!process.stdin.isTTY)input=fs.readFileSync(0,'utf-8');
const data=JSON.parse(input),tool=data.tool_name||data.toolName||'';
if(!['Write','Edit'].includes(tool))process.exit(0);
const filePath=data.parameters?.file_path||data.parameters?.filePath||'';
const content=data.parameters?.content||data.parameters?.new_string||'';
const CODE_EXT=/\.(js|ts|tsx|jsx|py|go|rs|java|kt|swift|c|cpp|h|hpp|rb|php|sh|bash|zsh|yaml|yml|json|toml|xml|sql|r|m|mm|cs|fs|fsx|scala|dart|ex|exs|clj|cljs|hs|elm|vue|svelte|astro)$/i;
if(filePath&&!CODE_EXT.test(filePath))process.exit(0);
const lineCount=content.split('\n').length;if(lineCount<10){process.exit(0)}
const checks=['## DW Check ( '+lineCount+' lines)'];
if(lineCount>=11)checks.push(' context7 latest docs? (A4)');
if(lineCount>=11)checks.push(' TDD: write tests first? (B4)');
if(lineCount>=11)checks.push(' code-review after? (B4)');
if(/\.(ts|tsx|jsx)$/i.test(filePath))checks.push(' TypeScript: use ts-reviewer after?');
if(/\.py$/i.test(filePath))checks.push(' Python: use python-reviewer after?');
if(/\.go$/i.test(filePath))checks.push(' Go: use go-reviewer after?');
if(/\.rs$/i.test(filePath))checks.push(' Rust: use rust-reviewer after?');
if(lineCount>=50){checks.push(' >50 lines: CONFIRM (B1: )');}
const extra=lineCount>=50?{permissionDecision:'ask',permissionDecisionReason:'>50 lines, confirm operational guideline written (B1)'}:undefined;
require('./task-utils.js').outputHook('PreToolUse',`<dw-tool-routing>\n${checks.join('\n')}\n</dw-tool-routing>`,extra);
}catch(e){process.exit(0)}
