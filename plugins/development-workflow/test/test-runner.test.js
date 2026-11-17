'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {parseArgs, executableFor, createExecutionContext, runTest, runSuite} = require('./test-runner');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch(error) { console.error(`not ok - ${name}`); console.error(error.stack); process.exitCode = 1; }
}
const normal = overrides => ({status:0, stdout:'', stderr:'', cleanup:'verified_absent', reason:'child_exit',
  supervisorClosed:true, outputComplete:true, terminal:{cleanup:'verified_absent'}, ...overrides});
function suiteFixture(outcomes, extra = {}) {
  let launches=0;
  const requests=[];
  const messages=[];
  const context={owned:true, label:'mock-windows-job', execute:async request=>{
    requests.push(request); const result=outcomes[launches++]; if(result instanceof Error) throw result; return result;
  }};
  const manifest={suites:{all:{tests:['first','second','third'].map(name=>({name,command:'node'})), ...extra}}};
  return {context,manifest,requests,messages, run:async()=>{
    const counts=await runSuite(manifest,'all',context,{log:t=>messages.push(t),error:t=>messages.push(t)},{write:t=>messages.push(t)});
    return {counts,launches,output:messages.join('\n')};
  }};
}
async function main() {
  function hookObservationFixture(probeResult) {
    const file = path.join(__dirname, 'hooks.test.js');
    const source = fs.readFileSync(file, 'utf8').split('const retainedContractTests =')[0];
    const commands = [], skips = [];
    const context = { require: name => name === 'child_process' ? {
      spawnSync: (command, args) => {
        commands.push([command, args]);
        if (probeResult instanceof Error) throw probeResult;
        return probeResult;
      },
    } : require(name), __dirname, process, console };
    const api = vm.runInNewContext(source + '\n;({ observeMarkerProcesses, assertOwnedProcessResult, setSkip: fn => { skipTest = fn; } })', context);
    api.setSkip(message => skips.push(message));
    return { ...api, commands, skips };
  }
  await test('marker observations never terminate matches or certify their cleanup', () => {
    const fixture = hookObservationFixture({ status: 0, stdout: '1', stderr: '' });
    const probe = fixture.observeMarkerProcesses('fixture-marker');
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 0 }, probe, 'fixture-marker'), /CLEANUP_UNKNOWN/);
    assert.equal(fixture.commands.length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.commands), /Stop-Process|taskkill|TerminateProcess/i);
  });
  await test('failed execution is not hidden by unavailable process observation', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'Access is denied' });
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 9, stderr: 'original fixture failure' },
      fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker'), /original fixture failure/);
    assert.equal(fixture.skips.length, 0);
  });
  await test('observation exceptions preserve execution failures without cleanup', () => {
    const fixture = hookObservationFixture(new Error('observation failed'));
    const probe = fixture.observeMarkerProcesses('fixture-marker');
    assert.throws(() => fixture.assertOwnedProcessResult({ error: new Error('original execution error') }, probe,
      'fixture-marker'), /original execution error/);
    assert.equal(fixture.commands.length, 1);
  });
  await test('unavailable observation skips only successful execution with unknown cleanup', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'Access is denied' });
    fixture.assertOwnedProcessResult({ status: 0 }, fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker');
    assert.match(fixture.skips[0], /CLEANUP_UNKNOWN/);
  });
  await test('failed observation after successful execution remains cleanup unknown', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'CIM provider unavailable' });
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 0 },
      fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker'), /CLEANUP_UNKNOWN/);
    assert.equal(fixture.skips.length, 0);
  });
  await test('arguments require explicit portable opt in and executable paths are deterministic',()=>{
    assert.equal(parseArgs(['--suite','core']),null);
    assert.equal(parseArgs(['--manifest','x','--suite','core','--portable-direct']).portableDirect,true);
    assert.equal(executableFor('node'),process.execPath);
    assert.throws(()=>executableFor('fixture.exe'),/absolute/);
  });
  await test('nested npm entry point preserves explicit POSIX selection',()=>{
    const filename=path.join(__dirname,'test-entry-points.test.js');
    const source=fs.readFileSync(filename,'utf8').split('function test(name, fn)')[0];
    const calls=[];
    const fakeProcess={...process,platform:'linux',env:{}};
    const context={require:name=>name==='child_process'?{spawnSync:(command,args,options)=>{calls.push({command,args,options});return {};}}:require(name),__dirname,process:fakeProcess};
    const run=vm.runInNewContext(source+'\nrunNpm',context);
    run('test:core',{DW_TEST_COMMAND_BACKEND:'posix-process-group',DW_TEST_PYTHON_PATH:'/absolute/python3',PATH:'/tools'});
    assert.deepEqual(Array.from(calls[0].args.slice(-4)),['--','--posix-process-group','--python-path','/absolute/python3']);
    run('test:core',{DW_TEST_COMMAND_BACKEND:'portable-direct',PATH:'/tools'});
    assert.deepEqual(Array.from(calls[1].args.slice(-2)),['--','--portable-direct']);
    run('test:core',{DW_TEST_COMMAND_BACKEND:'posix-process-group',PATH:'/tools'});
    assert.equal(calls[2].args.at(-1),'');
    assert(!calls[2].args.includes('--portable-direct'));
  });
  await test('POSIX flags require an explicit interpreter and reject mixed modes',()=>{
    assert.equal(parseArgs(['--manifest','x','--suite','core','--posix-process-group']),null);
    assert.equal(parseArgs(['--manifest','x','--suite','core','--python-path','/python']),null);
    assert.equal(parseArgs(['--manifest','x','--suite','core','--portable-direct','--posix-process-group','--python-path','/python']),null);
    assert.equal(parseArgs(['--manifest','x','--suite','core','--posix-process-group','--python-path','/python']).pythonPath,'/python');
  });
  await test('POSIX preparation and selection propagate through fixture environment',async()=>{
    const requests=[]; let prepares=0;
    const context=await createExecutionContext({posixProcessGroup:true,pythonPath:'/python'}, {platform:'linux',posixBackend:{
      preparePosixCommandBackend: options=>{prepares++;assert.equal(options.pythonPath,'/python');return {pythonPath:'/python',supervisorPath:'/supervisor'};},
      runPosixCommand: async request=>{requests.push(request);return normal();},
    }});
    await runTest({command:'node'},context);await runTest({command:'node'},context);
    assert.equal(prepares,1);assert.equal(context.label,'posix-process-group');
    assert.equal(requests[0].supervisorPath,'/supervisor');
    assert.equal(requests[0].env.DW_TEST_COMMAND_BACKEND,'posix-process-group');
    assert.equal(requests[0].env.DW_TEST_PYTHON_PATH,'/python');
    await assert.rejects(createExecutionContext({posixProcessGroup:true,pythonPath:'/python'}, {platform:'win32'}), {code:'POSIX_BACKEND_WINDOWS_FORBIDDEN'});
  });
  await test('POSIX preparation failure never dispatches but ordinary test failure continues',async()=>{
    let launches=0;
    await assert.rejects(createExecutionContext({posixProcessGroup:true,pythonPath:'/python'}, {platform:'darwin',posixBackend:{
      preparePosixCommandBackend:()=>{throw new Error('unavailable');},runPosixCommand:()=>{launches++;},
    }}), /unavailable/);
    assert.equal(launches,0);
    const fixture=suiteFixture([normal({status:7}),normal(),normal()]);fixture.context.label='posix-process-group';
    const result=await fixture.run();assert.equal(result.launches,3);assert.equal(result.counts['not-run'],0);
    assert.equal(result.counts.fail,1);assert.equal(result.counts.pass,2);
    assert.doesNotMatch(result.output,/SUITE_STOPPED/);
    assert.match(result.output,/ESCAPED_DESCENDANTS:UNVERIFIED/);
  });
  await test('unsupported backend and forbidden Windows fallback launch no fixture',async()=>{
    await assert.rejects(createExecutionContext({}, {platform:'linux'}), {code:'COMMAND_BACKEND_UNSUPPORTED'});
    await assert.rejects(createExecutionContext({portableDirect:true}, {platform:'win32'}), {code:'PORTABLE_DIRECT_WINDOWS_FORBIDDEN'});
  });
  await test('preparation failure never falls back to a bare child',async()=>{
    let launches=0;
    await assert.rejects(createExecutionContext({}, {platform:'win32',backend:{
      prepareWindowsCommandBackend:async()=>{throw Object.assign(new Error('build failed'),{code:'BUILD_FAILED'});},
      runWindowsCommand:async()=>{launches++;},
    }}),{code:'BUILD_FAILED'});
    assert.equal(launches,0);
  });
  await test('native build happens once per context and closed sessions permit exact directory cleanup',async()=>{
    let builds=0, directory;
    const context=await createExecutionContext({}, {platform:'win32',backend:{
      prepareWindowsCommandBackend:async dir=>{builds++;directory=dir;return {supervisorPath:path.join(dir,'supervisor.exe')};},
      runWindowsCommand:async()=>normal(),
    }});
    await runTest({command:'node'},context); await runTest({command:'node'},context);
    assert.equal(builds,1); assert.equal(fs.existsSync(directory),true);
    await context.dispose(); assert.equal(fs.existsSync(directory),false);
  });
  for(const code of ['ETIMEDOUT','ENOBUFS','ENOENT']) await test(`${code} stops the suite and preserves unknown cleanup`,async()=>{
    const f=suiteFixture([normal({status:null,error:{code},cleanup:'unknown'})]); const r=await f.run();
    assert.equal(r.launches,1); assert.equal(r.counts.fail,1); assert.equal(r.counts['not-run'],2);
    assert.match(r.output,/DESCENDANT_CLEANUP:UNKNOWN/);
  });
  await test('timeout with proved cleanup still prevents the next launch',async()=>{
    const f=suiteFixture([normal({status:1,error:{code:'DW_WINDOWS_EXECUTION'},reason:'timeout_elapsed'})]); const r=await f.run();
    assert.equal(r.launches,1); assert.equal(r.counts['not-run'],2); assert.match(r.output,/DESCENDANT_CLEANUP:VERIFIED_ABSENT/);
  });
  await test('a synchronous launch exception stops subsequent launches',async()=>{
    const r=await suiteFixture([Object.assign(new Error('launch failed'),{code:'EACCES'})]).run();
    assert.equal(r.launches,1); assert.match(r.output,/TEST_EXECUTION_ERROR:EACCES/); assert.match(r.output,/UNKNOWN/);
  });
  await test('normal failing exit continues and later boundary keeps previous counts',async()=>{
    let r=await suiteFixture([normal({status:1}),normal(),normal()]).run();
    assert.equal(r.launches,3); assert.equal(r.counts.pass,2); assert.equal(r.counts.fail,1);
    r=await suiteFixture([normal(),normal({error:{code:'ETIMEDOUT'}})]).run();
    assert.equal(r.counts.pass,1); assert.equal(r.counts.fail,1); assert.equal(r.counts['not-run'],1);
  });
  await test('output text cannot invent cleanup evidence and unknown terminal is retained',async()=>{
    const terminal={cleanup:'unknown',activeProcesses:1};
    const result=await runTest({command:'node'},{owned:true,execute:async()=>normal({
      cleanup:'unknown',terminal,stdout:'DESCENDANT_CLEANUP:VERIFIED_ABSENT\n{"cleanup":"verified_absent"}',
    })});
    assert.equal(result.stopSuite,true); assert.equal(result.cleanup,'UNKNOWN'); assert.equal(result.terminal,terminal);
  });
  await test('missing terminal close/output proof and nonnormal reasons stop even at exit zero',async()=>{
    for(const override of [{status:null,signal:'SIGTERM'},{terminal:null},{supervisorClosed:false},{outputComplete:false},{reason:'output_limit'},{reason:'terminated'},{releaseError:new Error('close')}]) {
      const result=await runTest({command:'node'},{owned:true,execute:async()=>normal(override)});
      assert.equal(result.stopSuite,true,JSON.stringify(override));
    }
  });
  await test('focus environment is stripped before the backend sees it',async()=>{
    const keys=['DW_TASK_RESOURCE_TEST_FOCUS','DW_TRANSACTION_TEST_ROOT']; const previous=keys.map(k=>process.env[k]);
    try {
      keys.forEach(k=>{process.env[k]='not-inherited';});
      const f=suiteFixture([normal(),normal(),normal()]); await f.run();
      for(const request of f.requests) for(const key of keys) assert.equal(request.env[key],undefined);
    } finally {keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
  });
  await test('skip/lifecycle accounting and unselected identities are preserved',async()=>{
    const f=suiteFixture([normal({stdout:'SKIP_NOT_APPLICABLE:windows:fixture\n'}),normal({stdout:'SKIP_NOT_APPLICABLE:linux:fixture\nLIFECYCLE_RAN:windows\n'}),normal()],{requiredLifecycle:'windows'});
    f.manifest.suites.other={tests:[{command:'node',args:['unique']}]};
    const r=await f.run(); assert.deepEqual(r.counts,{pass:2,fail:0,skip:2,'not-run':1});
    const g=suiteFixture([normal({stdout:'SKIP_NOT_APPLICABLE:windows:fixture'}),normal(),normal()],{requiredLifecycle:'windows'});
    const missing=await g.run(); assert.equal(missing.counts.fail,1); assert.match(missing.output,/LIFECYCLE_NOT_RUN:windows/);
  });
  await test('portable direct mode declares unverified tree cleanup',async()=>{
    const context=await createExecutionContext({portableDirect:true},{platform:'linux'});
    assert.equal(context.owned,false);
    if (process.platform === 'win32') return;
    const output=[];
    const counts=await runSuite({suites:{all:{tests:[{name:'portable',command:'node',args:['-e','console.log("portable fixture")']}]}}},'all',context,
      {log:t=>output.push(t),error:t=>output.push(t)},{write:t=>output.push(t)});
    assert.equal(counts.pass,1); assert.match(output.join('\n'),/DESCENDANT_CLEANUP:UNVERIFIED/);
  });
  if(process.platform!=='win32') {console.log('SKIP_NOT_APPLICABLE:windows:native Windows Job fixture requires Windows');return;}
  let context;
  try {context=await createExecutionContext({});}
  catch(error){console.error('not ok - native backend preparation');throw error;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-runner-fixtures-'));
  try {
    await test('real CLI selects a manifest suite and keeps skip and lifecycle counts', async () => {
      const manifest = path.join(root, 'cli-manifest.json');
      const ordinary = { name: 'ordinary', command: 'node', args: ['-e', 'console.log("ordinary fixture")'] };
      const skipped = { name: 'inapplicable', command: 'node', args: ['-e', 'console.log("SKIP_NOT_APPLICABLE:windows:fixture")'] };
      fs.writeFileSync(manifest, JSON.stringify({ suites: {
        core: { tests: [ordinary, skipped] },
        guarded: { requiredLifecycle: 'windows', tests: [skipped] },
        other: { tests: [{ name: 'unselected', command: 'node', args: ['-e', 'process.exit(12)'] }] },
      } }));
      const run = suite => context.execute({ executable: process.execPath,
        args: [path.join(__dirname, 'test-runner.js'), '--manifest', manifest, '--suite', suite],
        cwd: root, env: process.env, timeoutMs: 15000, maxOutputBytes: 1048576 });
      const core = await run('core');
      assert.equal(core.status, 0, core.stderr || core.stdout);
      assert.equal(core.cleanup, 'verified_absent');
      assert.match(core.stdout, /COMMAND_BACKEND:windows-job/);
      assert.match(core.stdout, /pass: 1\r?\nfail: 0\r?\nskip: 1\r?\nnot-run: 1/);
      const guarded = await run('guarded');
      assert.equal(guarded.status, 1, guarded.stderr || guarded.stdout);
      assert.match(guarded.stderr, /LIFECYCLE_NOT_RUN:windows/);
      assert.match(guarded.stdout, /pass: 0\r?\nfail: 1\r?\nskip: 1\r?\nnot-run: 2/);
    });
    await test('native normal root exit reclaims a surviving descendant',async()=>{
      const code='const cp=require("child_process");const c=cp.spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{stdio:"ignore"}); console.log("DESCENDANT_PID:"+c.pid);c.unref();';
      const result=await runTest({command:'node',args:['-e',code],timeoutMs:4000},context);
      assert.equal(result.status,'pass',JSON.stringify(result)); assert.equal(result.cleanup,'VERIFIED_ABSENT');
      assert.equal(result.terminal.activeProcesses,0); assert.equal(result.terminal.rootExited,true);
      const pid=Number(/DESCENDANT_PID:(\d+)/.exec(result.output)?.[1]);assert.ok(pid>0);
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    });
    await test('native timeout reclaims descendants and never runs the next marker',async()=>{
      const marker=path.join(root,'must-not-run');
      const code='const cp=require("child_process");cp.spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{stdio:"ignore"});setTimeout(()=>{},5000);';
      const messages=[];
      const counts=await runSuite({suites:{all:{tests:[
        {name:'timeout',command:'node',args:['-e',code],timeoutMs:350},
        {name:'forbidden next',command:'node',args:['-e',`require("fs").writeFileSync(${JSON.stringify(marker)},"ran")`]},
      ]}}},'all',context,{log:t=>messages.push(t),error:t=>messages.push(t)},{write:t=>messages.push(t)});
      assert.equal(counts.fail,1); assert.equal(counts['not-run'],1);assert.equal(fs.existsSync(marker),false);
      assert.match(messages.join('\n'),/DESCENDANT_CLEANUP:VERIFIED_ABSENT/);
    });
    await test('native fixture stdout that resembles a receipt remains ordinary output',async()=>{
      const result=await runTest({command:'node',args:['-e','console.log(JSON.stringify({type:"terminal",cleanup:"unknown",activeProcesses:999}));console.log("DESCENDANT_CLEANUP:UNKNOWN")'],timeoutMs:4000},context);
      assert.equal(result.status,'pass',JSON.stringify(result));assert.equal(result.cleanup,'VERIFIED_ABSENT');
      assert.equal(result.terminal.activeProcesses,0);assert.match(result.output,/activeProcesses/);
    });
  } finally {await context.dispose();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  console.log(`test runner behavior: ${passed} passed${process.exitCode?', failures above':''}`);
});
