#!/usr/bin/env node
'use strict';
try{let input='';if(!process.stdin.isTTY)input=require('fs').readFileSync(0,'utf-8');
const data=JSON.parse(input),tool=data.tool_name||data.toolName||'';
if(!['Write','Edit'].includes(tool))process.exit(0);
const paramsStr=JSON.stringify(data.parameters||data.tool_input||{});
const lineCount=paramsStr.split('\n').length;if(lineCount<5)process.exit(0);
const checklist=['## DW ( )',
' B1: ( )',' A4: context7 ( )',' A1: Edit ',' B4: ( )'];
if(lineCount>50){checklist.push(' >50: ');}
const extra=lineCount>50?{permissionDecision:'ask',permissionDecisionReason:' >50 B1'}:undefined;
require('./task-utils.js').outputHook('PreToolUse',`<dw-tool-routing>\n${checklist.join('\n')}\n</dw-tool-routing>`,extra);
}catch(e){process.exit(0)}
