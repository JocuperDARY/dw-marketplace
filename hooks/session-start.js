#!/usr/bin/env node
'use strict';
const path=require('path'),fs=require('fs');
const{findProjectRoot,getActiveTask,readFileSafe,detectTechStack,getGitInfo,outputHook}=require('./task-utils.js');
const{findProjectRoot,getActiveTask,detectTechStack,getGitInfo,outputHook}=require("./task-utils.js");
const HOME=process.env.HOME||process.env.USERPROFILE||'';
const MARKER_FILE=path.join(HOME,'.claude','.cache','dw-session-done.txt');
const SESSION_TTL_MS=5*60*1000;
try{let last=0;try{last=parseInt(fs.readFileSync(MARKER_FILE,'utf-8'),10)}catch{}if(Date.now()-last<SESSION_TTL_MS)process.exit(0);
const cwd=process.env.CLAUDE_PROJECT_DIR||process.cwd();const root=findProjectRoot(cwd);const sections=[];
const HOOK_STATUS=[
{name:'tool-inventory.js',trigger:'UserPromptSubmit(first)',desc:'扫描 318+ 工具，17 类别分类',icon:'🟢'},
{name:'skill-router.js',trigger:'UserPromptSubmit(each)',desc:'TF-IDF 语义匹配 + DW 子Skill 路由',icon:'🟢'},
{name:'workflow-state.js',trigger:'UserPromptSubmit(each)',desc:'七阶段门控追踪 + 循环检测',icon:'🟢'},
{name:'session-start.js',trigger:'UserPromptSubmit(first)',desc:'项目上下文 + 工具协议 + memory',icon:'🟢'},
{name:'tool-routing.js',trigger:'PreToolUse(Write|Edit)',desc:'铁律A1/B1/B4 代码变更前检查',icon:'🟢'},
{name:'subagent-context.js',trigger:'PreToolUse(Bash|Agent)',desc:'子代理上下文注入 (spec/PRD/plan)',icon:'🟢'},
{name:'prune-rules.js',trigger:'SessionStart',desc:'按项目语言裁剪规则文件',icon:'🟢'},
];
sections.push(['╔══════════════════════════════════════════════════════════╗','║        🔧 DW PLUGIN HOOKS — ALL SYSTEMS ACTIVE        ║','╠══════════════════════════════════════════════════════════╣',
...HOOK_STATUS.map(h=>{const l=`║ ${h.icon} ${h.name.padEnd(24)} ${h.trigger.padEnd(26)} ${h.desc}`;return l+' '.repeat(Math.max(0,54-l.length+2))+'║';}),
'╚══════════════════════════════════════════════════════════╝'].join('\n'));
if(root){sections.push(`<project>\n  Tech: ${detectTechStack(root)}\n  Branch: ${getGitInfo(root).branch}\n  Dirty files: ${getGitInfo(root).dirtyCount}\n  Root: ${root}\n  </project>`);
const task=getActiveTask(root);if(task)sections.push(`<active-task>\nTask: ${task.title||task.id} (${task.status})\nStrategy: ${task.strategy}\nPhase: ${task.currentPhase}\nNext: ${task.nextAction||'Continue'}\n</active-task>`);
}else{sections.push('<project>No project root detected.</project>');}
sections.push(`<proactive-tool-protocol>\nCORE RULES:\n1. Code understanding → mcp__codegraph__codegraph_explore FIRST\n2. Library/API → mcp__context7__resolve-library-id + mcp__context7__query-docs BEFORE code\n3. Complex reasoning → mcp__sequential-thinking__sequentialthinking\nFull: tool-scanning.md + tool-proact-skills.md\n</proactive-tool-protocol>`);
sections.push(`<memory-auto-load>\nIMPORTANT: Call mcp__memory__read_graph at session start. Apply stored tool-usage-discipline and work_rule entities.\n</memory-auto-load>`);
if(!fs.existsSync(path.dirname(MARKER_FILE)))fs.mkdirSync(path.dirname(MARKER_FILE),{recursive:true});
fs.writeFileSync(MARKER_FILE,String(Date.now()),'utf-8');
outputHook('UserPromptSubmit',`<dw-session>\n${sections.join('\n\n')}\n</dw-session>`);
}catch(e){process.exit(0)}
