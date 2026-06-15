#!/usr/bin/env node
'use strict';
try{const{findProjectRoot,detectTechStack,getGitInfo,outputHook}=require('./task-utils.js');
const root=findProjectRoot(process.env.CLAUDE_PROJECT_DIR||process.cwd());if(!root)process.exit(0);
const stack=detectTechStack(root),git=getGitInfo(root);
const lines=['<dw-session>',
'DW Hooks: skill-router|tool-routing|workflow-state|session-start|subagent-context|prune-rules',
`Project: ${require('path').basename(root)} | Tech: ${stack} | Branch: ${git.branch} | Dirty: ${git.dirtyCount}`,
' 铁律A4: codegraph_explore  | context7 resolve+query | sequential-thinking  | tavily_search',
'</dw-session>'];
outputHook('UserPromptSubmit',lines.join('\n'));
}catch(e){process.exit(0)}
