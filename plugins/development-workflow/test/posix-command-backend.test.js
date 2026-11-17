'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const backend = require('../skills/dw-collaboration/scripts/lib/posix-command-backend');
const request = {pythonPath:'/usr/bin/python3', supervisorPath:'/tmp/supervisor.py', executable:'/usr/bin/node', args:[], cwd:'/tmp', timeoutMs:100, maxOutputBytes:100};
function fakeSpawn(record, mutate = () => {}) {
  return (...args) => {
    const child = new EventEmitter(); child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough()]; child.unref=()=>{};
    child.stdin.on('finish',()=>process.nextTick(()=> {child.stdout.end(record); child.emit('close',0,null);}));
    mutate(args, child);
    return child;
  };
}
const result = {v:1,session:'SESSION',containment:'posix-process-group',escapedDescendants:'unverified',status:0,signal:null,reason:'child_exit',cleanup:'verified_absent',outputComplete:true,rootExited:true,guardianReaped:true,groupAbsent:true,killRequested:true,pgid:123,stdout:'b2s=',stderr:''};
(async()=>{
  assert.throws(()=>backend.preparePosixCommandBackend({pythonPath:'python3',platform:'linux'}), /absolute/);
  assert.throws(()=>backend.preparePosixCommandBackend({pythonPath:process.execPath,platform:'win32'}), /POSIX/);
  for (const field of ['groupAbsent','guardianReaped','rootExited','killRequested']) {
    assert.throws(()=>backend.decodeResult({...result,[field]:false},'SESSION',100), /evidence/);
  }
  assert.throws(()=>backend.decodeResult({...result,session:'foreign'},'SESSION',100),/session/);
  assert.throws(()=>backend.decodeResult({...result,stdout:'!'},'SESSION',100),/base64/);
  assert.throws(()=>backend.decodeResult({...result,stdout:Buffer.alloc(101).toString('base64')},'SESSION',100),/output/);
  assert.throws(()=>backend.decodeResult({...result,containment:'job'},'SESSION',100),/containment/);
  assert.throws(()=>backend.decodeResult({...result,signal:9},'SESSION',100),/Contradictory/);
  assert.throws(()=>backend.decodeResult({...result,status:null},'SESSION',100),/exit evidence/);
  let seen;
  const spawn = fakeSpawn('',(args,child)=>{seen=args; child.stdin.removeAllListeners('finish'); child.stdin.on('finish',()=>process.nextTick(()=>{const input=JSON.parse(child.stdin.read().toString()); child.stdout.end(JSON.stringify({...result,session:input.session})+'\n');child.emit('close',0,null);}));});
  const good=await backend.runPosixCommand(request,{platform:'linux',spawn});
  assert.equal(good.stdout,'ok'); assert.equal(good.supervisorClosed,true); assert.equal(good.cleanup,'verified_absent'); assert.equal(good.error,null);
  assert.equal(seen[2].shell,false); assert.equal(seen[2].stdio[3],'pipe');
  const bad=await backend.runPosixCommand(request,{platform:'linux',spawn:fakeSpawn('{}\n')});
  assert.equal(bad.cleanup,'unknown'); assert.ok(bad.error);
  const extra=await backend.runPosixCommand(request,{platform:'linux',spawn:fakeSpawn(JSON.stringify(result)+'\n{}\n')});
  assert.equal(extra.cleanup,'unknown');
  const timeout=backend.decodeResult({...result,reason:'timeout_elapsed'},'SESSION',100); assert.ok(timeout.error); assert.equal(timeout.cleanup,'verified_absent');
  console.log('POSIX_BACKEND_CONTRACT: passed; native Linux/macOS NOT_RUN');
})().catch(error=>{console.error(error);process.exitCode=1;});
