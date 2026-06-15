#!/usr/bin/env node
'use strict';
try{const{detectTechStack,outputHook,findProjectRoot}=require('./task-utils.js');
const root=findProjectRoot(process.env.CLAUDE_PROJECT_DIR||process.cwd());if(!root)process.exit(0);
const stack=detectTechStack(root).toLowerCase();const keep=new Set();
for(const l of ['node','python','typescript','javascript','go','rust','java','cpp'])if(stack.includes(l)){keep.add(l);if(l==='javascript')keep.add('typescript');}
if(!keep.size)process.exit(0);
outputHook('SessionStart',`<dw-prune-rules>\nLang: ${stack}. Rules: ${[...keep].join(',')}\n</dw-prune-rules>`);
}catch(e){process.exit(0)}
