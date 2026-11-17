'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const MAX_OUTPUT = 64 * 1024 * 1024;
const REASONS = new Set(['child_exit', 'timeout_elapsed', 'output_limit', 'control_eof', 'guardian_error', 'backend_failure']);
function fault(message) { return Object.assign(new Error(message), {code:'DW_POSIX_BOUNDARY'}); }
function check(test, message) { if (!test) throw fault(message); }
function absolute(value) { return typeof value === 'string' && path.posix.isAbsolute(value) && !value.includes('\0'); }
function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }

function preparePosixCommandBackend({pythonPath, platform = process.platform} = {}) {
  check(platform !== 'win32', 'POSIX process-group backend unavailable on Windows');
  check(absolute(pythonPath), 'An explicit absolute POSIX Python interpreter path is required');
  check(fs.statSync(pythonPath).isFile(), 'Python interpreter is not a file');
  const supervisorPath = path.resolve(__dirname, '../process-supervisor/posix_command_supervisor.py');
  check(fs.statSync(supervisorPath).isFile(), 'POSIX supervisor is missing');
  return Object.freeze({pythonPath, supervisorPath});
}
function validate(options) {
  const value = {...options, args:options.args || [], cleanupMs:options.cleanupMs ?? 3000};
  for (const key of ['pythonPath','supervisorPath','executable','cwd']) check(absolute(value[key]), `${key} must be an absolute POSIX path`);
  check(Array.isArray(value.args) && value.args.length <= 4096 && value.args.every(x=>typeof x==='string' && !x.includes('\0')), 'Invalid argument vector');
  check(integer(value.timeoutMs,1,2147000000) && integer(value.cleanupMs,100,30000), 'Invalid finite deadline');
  check(integer(value.maxOutputBytes,1,MAX_OUTPUT), 'Invalid output limit');
  check(value.env === undefined || (value.env !== null && typeof value.env === 'object' && !Array.isArray(value.env) && Object.entries(value.env).every(([k,v])=>k && !/[=\0]/.test(k) && typeof v==='string' && !v.includes('\0'))), 'Invalid environment');
  return value;
}
function decodeResult(value, session, maxOutputBytes) {
  check(value && value.v===1 && value.session===session, 'Invalid POSIX protocol session');
  check(value.containment==='posix-process-group' && value.escapedDescendants==='unverified', 'Invalid containment scope');
  check(REASONS.has(value.reason), 'Invalid terminal reason');
  check(['verified_absent','unknown'].includes(value.cleanup), 'Invalid cleanup');
  check(value.status === null || integer(value.status,0,255), 'Invalid exit status');
  check(value.signal === null || integer(value.signal,1,127), 'Invalid exit signal');
  check(value.status === null || value.signal === null, 'Contradictory exit evidence');
  for (const key of ['rootExited','guardianReaped','groupAbsent','killRequested','outputComplete']) check(typeof value[key]==='boolean', `Invalid ${key}`);
  if (value.rootExited) check(value.status !== null || value.signal !== null, 'Missing root exit evidence');
  check(value.pgid === null || integer(value.pgid,2,2147483647), 'Invalid group identity');
  if (value.cleanup==='verified_absent') check(value.pgid!==null && value.guardianReaped && value.groupAbsent && value.killRequested && value.rootExited, 'Missing process-group absence evidence');
  const buffers = ['stdout','stderr'].map(key=>{
    check(typeof value[key]==='string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[key]), 'Invalid output base64');
    const bytes=Buffer.from(value[key],'base64'); check(bytes.toString('base64')===value[key], 'Noncanonical base64'); return bytes;
  });
  check(buffers[0].length+buffers[1].length<=maxOutputBytes, 'Shared output limit exceeded');
  const okay=value.reason==='child_exit' && value.cleanup==='verified_absent' && value.outputComplete && value.status!==null && value.signal===null;
  return {status:value.status,signal:value.signal,stdout:buffers[0].toString('utf8'),stderr:buffers[1].toString('utf8'),
    cleanup:value.cleanup,reason:value.reason,outputComplete:value.outputComplete,terminal:value,
    containment:value.containment,escapedDescendants:value.escapedDescendants,error:okay?null:fault(`POSIX command ended: ${value.reason}`)};
}
async function runPosixCommand(options, dependencies = {}) {
  const opts=validate(options);
  check((dependencies.platform || process.platform)!=='win32', 'POSIX process-group backend unavailable on Windows');
  const session=randomBytes(16).toString('hex');
  const failure=error=>({status:null,signal:null,stdout:'',stderr:'',cleanup:'unknown',reason:'backend_failure',outputComplete:false,terminal:null,
    supervisorClosed:false,containment:'posix-process-group',escapedDescendants:'unverified',error});
  return new Promise(resolve=>{
    let child, output=[], bytes=0, diagnosticBytes=0, ended=false;
    const finish=value=>{if(ended)return;ended=true;clearTimeout(timer);resolve(value);};
    const abort=error=>{
      if (ended) return;
      // Closing this private lifetime channel asks the live guardian to stop.
      // Never signal a remembered PID/PGID from JavaScript.
      child?.stdio?.[3]?.destroy(); child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      finish(failure(error));
    };
    const timer=setTimeout(()=>abort(fault('POSIX controller deadline exceeded')),opts.timeoutMs+opts.cleanupMs+3000);
    try {
      child=(dependencies.spawn || spawn)(opts.pythonPath,['-I','-S',opts.supervisorPath],{cwd:opts.cwd,env:opts.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe','pipe']});
      child.on('error',abort); child.stdin.on('error',abort); child.stdio[3].on('error',abort);
      child.stdout.on('data',data=>{bytes+=data.length;if(bytes>Math.ceil(opts.maxOutputBytes*4/3)+16384)abort(fault('POSIX protocol output limit'));else output.push(data);});
      child.stderr.on('data',data=>{diagnosticBytes+=data.length;if(diagnosticBytes>65536)abort(fault('POSIX diagnostic output limit'));});
      child.once('close',(code,signal)=>{
        if(ended)return;
        try {check(code===0 && signal===null,'POSIX controller failed');const text=Buffer.concat(output).toString('utf8');check(text.endsWith('\n') && text.trim().split('\n').length===1,'Invalid POSIX terminal framing');
          const value=decodeResult(JSON.parse(text),session,opts.maxOutputBytes); child.stdio[3].destroy();finish({...value,supervisorClosed:true});
        } catch(error) {abort(error);}
      });
      const wire={v:1,session,executable:opts.executable,args:opts.args,cwd:opts.cwd,timeoutMs:opts.timeoutMs,cleanupMs:opts.cleanupMs,maxOutputBytes:opts.maxOutputBytes};
      child.stdin.end(JSON.stringify(wire)+'\n');
    } catch(error) {abort(error);}
  });
}
module.exports={preparePosixCommandBackend,runPosixCommand,decodeResult};
