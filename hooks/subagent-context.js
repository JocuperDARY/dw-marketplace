#!/usr/bin/env node
'use strict';
try{let input='';if(!process.stdin.isTTY)input=require('fs').readFileSync(0,'utf-8');
const data=JSON.parse(input),tool=data.tool_name||data.toolName||'';
if(!['Bash','Agent'].includes(tool))process.exit(0);
const{findProjectRoot}=require('./task-utils.js');
const root=findProjectRoot(process.env.CLAUDE_PROJECT_DIR||process.cwd());if(!root)process.exit(0);
const specDir=require('path').join(root,'.tool-proact','spec');
const fs=require('fs');if(!fs.existsSync(specDir))process.exit(0);
const files=fs.readdirSync(specDir).filter(f=>f.endsWith('.md')).slice(0,2);
if(!files.length)process.exit(0);
const ctx=['<dw-subagent-context>','## '];
for(const f of files){try{ctx.push(`\n### ${f}\n${fs.readFileSync(require('path').join(specDir,f),'utf-8').split('\n').slice(0,15).join('\n')}`)}catch{}}
ctx.push('</dw-subagent-context>');require('./task-utils.js').outputHook('PreToolUse',ctx.join('\n'));
}catch(e){process.exit(0)}
