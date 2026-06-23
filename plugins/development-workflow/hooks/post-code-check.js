#!/usr/bin/env node
'use strict';
try{const fs=require('fs'),path=require('path'),HOME=process.env.HOME||process.env.USERPROFILE||'';
let input='';if(!process.stdin.isTTY)input=fs.readFileSync(0,'utf-8');
const data=JSON.parse(input),tool=data.tool_name||data.toolName||'';
if(!['Write','Edit','MultiEdit','NotebookEdit'].includes(tool))process.exit(0);
const params=data.tool_input||data.parameters||data.input||{};
let content=params.content||params.new_string||params.newString||params.new_source||params.newSource||params.old_string||params.oldString||'';
if(!content&&Array.isArray(params.edits))content=params.edits.map(e=>e.new_string||e.newString||'').join('\n');
const filePath=params.file_path||params.filePath||params.notebook_path||params.notebookPath||'';
if(!(/\.(js|ts|tsx|jsx|py|go|rs|java|kt|c|cpp|h|rb|php|sh|yaml|yml|json|toml|sql)$/i.test(filePath)))process.exit(0);
const lines=content.split('\n').length;if(lines<10)process.exit(0);
const markerFile=path.join(HOME,'.claude','.cache','dw-review-needed.json');
let marker={files:[],count:0,lastLines:0,ts:Date.now()};
try{const old=JSON.parse(fs.readFileSync(markerFile,'utf-8'));if(Date.now()-old.ts<3e5)marker=old}catch{}
marker.files=[...new Set([...(marker.files||[]),path.basename(filePath)])];marker.count=(marker.count||0)+1;marker.lastLines=lines;marker.ts=Date.now();
fs.mkdirSync(path.dirname(markerFile),{recursive:true});
fs.writeFileSync(markerFile,JSON.stringify(marker),'utf-8');
}catch(e){process.exit(0)}
