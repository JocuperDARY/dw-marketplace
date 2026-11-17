# 资源队列与命令调度

`ResourceCommandDispatcher` 把 `ResourceAwareQueue` 的容量决策连接到受管命令。
它只保存当前进程中的队列和命令对应关系。manager 的持久资源记录不会被当成新队列输入，
重启后不会自动恢复、重放或重试旧命令。恢复需要调用者核对旧 run 的资源、授权和结果；
这个接口不提供自动恢复入口。

## 接口

```js
const dispatcher = new ResourceCommandDispatcher({
  host, // prepareCommand/startPrepared/cancelPrepared/closeCommand/queueAuthority/wait
  policy,
  authorizationResolver,
});
await dispatcher.prepare(profile, command);
await dispatcher.dispatch(observedCapacity);
await dispatcher.observe(taskId);
const snapshot = dispatcher.snapshot();
```

`command` 是 host 支持的有限命令输入；执行文件、参数、超时、工作目录和原生权限由 host 验证。
`profile` 含任务 ID、资源需求、依赖、优先级、授权引用与执行时长；无效资源 profile 在准备前拒绝。其中 `scopeBinding` 和
`trackedResourceIds` 总是由正式 `prepareCommand()` 返回值填入，调用者不能用 profile 改写它们。
`prepare()` 只声明正式资源，不启动进程。准备后未获准入的声明也需要关闭。

`queueAuthority()` 必须返回 tracker 模块创建的带内部品牌的冻结窄接口。
普通对象即使有同名方法也不能充当正式 authority。直接构造队列的历史 tracker 参数仍可用，
公开的 `queue.tracker` 仅是冻结窄接口，不暴露 register、bind 或 confirmRelease 等写入能力。

每次 `dispatch(observation)` 仅取一次容量观察并执行一次调度，返回 decision 和完整脱离内部状态的
snapshot。被选中的任务先占容量，再启动；一次启动失败会终止本轮后续启动并关闭尚未启动的声明。
已启动成员继续等待各自的观察与关闭。没有自动补槽、后台轮询或无限重试。

`observe(taskId)` 等待 host 的有限 wait，记录返回观察，并进入 draining；只有有 terminal 记录、
`reason: child_exit`、退出码为 0、没有 host error、`outputComplete: true` 且
`cleanup: verified_absent` 才记为 completed。其他观察为 failed，但失败本身不释放容量。
wait 的完成判据不包含尚未释放的 supervisor handle；该 handle 的正式关闭由后续 host close 验证。
观察快照保留退出码、原因、cleanup、outputComplete、terminal、标准输出/错误和 errorCode；
不会把 Error 实例、堆栈或未定义的实现字段带入快照。缺失的退出码、原因、cleanup、terminal 为 null，
缺失的 outputComplete 为 false，host 抛错则记录为命令 error，不能成为完成证据。
host 自身必须限制命令时限和所有原生调用；dispatcher 不会用 Promise 超时伪装原生工作已结束。

`cancel(taskId)` 可取消尚未启动、正在启动或运行中的命令。启动进行中时先等该次调用结束，
再关闭实际资源；重复调用共享正在进行的关闭。运行中的晚到 wait 不能覆盖取消结果。
同一 dispatcher 拒绝重复 task ID、command ID 和重入调度；重复 observe 不会再次 wait。

## 容量释放条件

从 running 到 draining 不会释放槽位。启动异常也不会释放槽位。
`closeCommand()` 或未启动命令的 `cancelPrepared()` 必须返回对应 command ID 的 CLOSED 及正式 scope close token，
且队列必须成功消费该 token，才会进入 completed、failed 或 cancelled。
Windows host 还必须先确认原生 session 和 Job 已释放，再向 dispatcher 交付 token。
伪造、跨任务、过期或已错误消费的 token 均不能证明释放。

若关闭返回 CLOSING、HOLD、异常或无法验证的 token，snapshot 保留 draining 与错误码。
调用者可以在取得后续证据后显式调用一次 `close(taskId)` 重查；该方法不会重新启动命令。
未调度取消的任务在清理声明期间也保守占用容量，直到正式关闭完成。

snapshot 不包含 manager、host、可写 tracker 或 close token。终态任务仍计入本 dispatcher 的
`maxTasks`，用于限制单次会话中的总命令数；不会清空历史后扩大发送额度。

## 验证范围

`test/resource-command-dispatcher.test.js` 用正式 tracker 的内存 fixture 验证准备、调度、
部分启动、关闭 token、取消、晚到、重复与重入。这是契约验证，不能代替平台验收。
同一测试文件包含 Windows 的有限原生 fixture：两条排队 Node 命令以及一条不存在的 executable，
经现有受管测试入口验证关闭与归还容量；其他平台必须独立验收。
