#!/usr/bin/env node
'use strict';
try{let input='';if(!process.stdin.isTTY)input=require('fs').readFileSync(0,'utf-8');
const data=JSON.parse(input),tool=data.tool_name||data.toolName||'';
if(!['Write','Edit'].includes(tool))process.exit(0);
const paramsStr=JSON.stringify(data.parameters||data.tool_input||{});
const lines=paramsStr.split('\n').length;if(lines<5)process.exit(0);
const checklist=['## DW 铁律检查 (代码变更前)',
' B1: 是否已编写操作指引 (方案设计 计划 验收标准)',' A4: 是否先查了context7最新文档 (禁止凭记忆写代码)',' A1: 是否使用Edit工具修改代码',' B4: 写完是否计划过测试闸门 (测试 审查 安全扫描)'];
if(lines>50)checklist.push(' 变更>50行: 需用户确认后再继续');
require('./task-utils.js').outputHook('PreToolUse',`<dw-tool-routing>\n${checklist.join('\n')}\n</dw-tool-routing>`);
}catch(e){process.exit(0)}
