#!/usr/bin/env node
'use strict';
try{const path=require('path'),fs=require('fs');
const{findProjectRoot,getActiveTask,outputHook}=require('./task-utils.js');
function readFileSafe(f){try{return fs.readFileSync(f,'utf-8')}catch{return null}}
function readContextJsonl(taskDir){const p=path.join(taskDir,'context.jsonl');if(!fs.existsSync(p))return[];try{return fs.readFileSync(p,'utf-8').split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(e=>e&&e.file)}catch{return[]}}

let inputData='';if(!process.stdin.isTTY)inputData=fs.readFileSync(0,'utf-8');
let toolInput={};try{const p=JSON.parse(inputData);toolInput=p.tool_input||p.input||p}catch{}
const command=toolInput.command||'',teamName=toolInput.team_name||'',agentName=toolInput.name||'';
const isCodeagentCall=command.includes('codeagent-wrapper'),isTeamSpawn=!!teamName;
if(!isCodeagentCall&&!isTeamSpawn)process.exit(0);
const root=findProjectRoot(process.env.CLAUDE_PROJECT_DIR||process.cwd());if(!root)process.exit(0);
const task=getActiveTask(root);if(!task)process.exit(0);

// Role detection
const ROLE_FILE_MAP={reviewer:'review',analyzer:'research',debugger:'debug',tester:'review',architect:'implement',optimizer:'implement',frontend:'implement'};
const AGENT_PATTERNS=[{pattern:/dev|builder|fix|impl/i,role:'implement'},{pattern:/review|check|audit/i,role:'review'},{pattern:/research|scout|explore|analy/i,role:'research'},{pattern:/debug|diagnos/i,role:'debug'}];
let role='implement';
if(isCodeagentCall){const m=command.match(/ROLE_FILE:.*\/(\w+)\.md/);if(m)role=ROLE_FILE_MAP[m[1]]||'implement'}
else if(isTeamSpawn&&agentName){for(const{p,r}of AGENT_PATTERNS){if(p.test(agentName)){role=r;break}}}

const ctx=[];
// Active task block
if(isTeamSpawn)ctx.push(`<dw-active-task>\nTask: ${task.title||task.id} (${task.status})\nStrategy: ${task.strategy}\nPhase: ${task.currentPhase}\nAgent role: ${role}\n</dw-active-task>`);

// Role-filtered specs from context.jsonl
const allEntries=readContextJsonl(task.dir);
const entries=allEntries.filter(e=>!e.roles||!Array.isArray(e.roles)||!e.roles.length||e.roles.includes(role)||e.roles.includes('all'));
if(entries.length){const specC=[];for(const e of entries){const c=readFileSafe(path.isAbsolute(e.file)?e.file:path.join(root,e.file));if(c)specC.push(`--- ${e.file} (${e.reason||'context'}) ---\n${c}`)}if(specC.length)ctx.push(`<dw-specs>\n${specC.join('\n\n')}\n</dw-specs>`)}

// PRD + Plan injection
const prd=readFileSafe(path.join(task.dir,'requirements.md')),plan=readFileSafe(path.join(task.dir,'plan.md'));
if(prd||plan){const tc=['<dw-task-context>'];if(prd)tc.push(`## Requirements\n${prd.length>2000?prd.substring(0,2000)+'\n...(truncated)':prd}`);if(plan)tc.push(`## Plan\n${plan.length>3000?plan.substring(0,3000)+'\n...(truncated)':plan}`);tc.push('</dw-task-context>');ctx.push(tc.join('\n'))}

// Research files (research + implement roles)
if(role==='research'||role==='implement'){const rd=path.join(task.dir,'research');if(fs.existsSync(rd)){try{const rf=fs.readdirSync(rd).filter(f=>f.endsWith('.md'));if(rf.length){const rc=rf.map(f=>{const c=readFileSafe(path.join(rd,f));return c?`--- research/${f} ---\n${c.substring(0,1500)}`:null}).filter(Boolean);if(rc.length)ctx.push(`<dw-research>\n${rc.join('\n\n')}\n</dw-research>`)}}catch{}}}

if(!ctx.length)process.exit(0);
const injected=`<dw-injected-context>\n${ctx.join('\n\n')}\n</dw-injected-context>`;
if(isTeamSpawn&&typeof toolInput.prompt==='string')outputHook('PreToolUse',null,{updatedInput:{...toolInput,prompt:`${injected}\n\n---\n\n${toolInput.prompt}`}});
else outputHook('PreToolUse',injected);
}catch(e){process.exit(0)}
