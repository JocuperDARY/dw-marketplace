#!/usr/bin/env node
'use strict';
try{const{findProjectRoot,getActiveTask,outputHook,trackTurn,detectLoop}=require('./task-utils.js');
const root=findProjectRoot(process.env.CLAUDE_PROJECT_DIR||process.cwd());if(!root)process.exit(0);
const task=getActiveTask(root);if(!task)process.exit(0);
const turns=trackTurn(task.dir,task.currentPhase,task.nextAction);
const loop=detectLoop(turns,3);
const dwPhase=task.currentPhase||'';
const dwPhases=['diagnosis','planning','implementation','data-integrity','test-gates','verification','wrapup'];
const phaseIdx=dwPhases.findIndex(p=>dwPhase.includes(p));
const lines=['<dw-workflow-state>',`Task: ${task.title||task.id} (${task.status})`,`Phase: ${dwPhase}${phaseIdx>=0?' ('+(phaseIdx+1)+'/7)':''}`,`Next: ${task.nextAction||'continue'}`];
if(loop){lines.push('',`WARNING: "${loop.phase}" repeated ${loop.count}x (${loop.elapsedSec}s) -> B4: reassess`);}
lines.push('</dw-workflow-state>');outputHook('UserPromptSubmit',lines.join('\n'));
}catch(e){process.exit(0)}
