/**
 * 本地告警（需求 7.4、9.1）：由连接状态、模型和规划的加载结果、接口检查、关节名对应得出，
 * 条件变化时写入 store；条件不再成立时消失。
 */
import type { LocalConditions } from '../domain/alarms.ts'
import { updateLocalAlarms } from '../domain/alarms.ts'
import { INTERFACE_VERSION } from '../ros/contract.ts'
import { selectInterfaceIssue, selectJointMismatch, type InterfaceIssue } from './selectors.ts'
import type { AppActions, AppState, AppStore } from './store.ts'

function issueText(issue: InterfaceIssue): string {
  switch (issue.kind) {
    case 'version':
      return `服务端接口版本 ${issue.detail}，APP 期望 ${INTERFACE_VERSION}`
    case 'schema':
      return `消息不符合接口约定：${issue.detail}`
    case 'value':
      return `不认识的取值：${issue.detail}`
  }
}

export function localConditions(s: AppState): LocalConditions {
  const conditions: LocalConditions = {}
  // 断线（需求 7.4）：WebSocket 已断开为网络连接断开；连接还在但收不到状态为服务端无响应
  if (s.conn.status === 'reconnecting') {
    if (s.conn.socketOpen) conditions.APP_SERVER_NO_RESPONSE = ''
    else conditions.APP_NETWORK_DOWN = ''
  }
  if (s.model.status === 'error') conditions.APP_MODEL_LOAD_FAILED = s.model.error ?? ''
  if (s.plan.status === 'error') conditions.APP_PLAN_LOAD_FAILED = s.plan.error ?? ''
  const issue = selectInterfaceIssue(s)
  if (issue) conditions.APP_INTERFACE_MISMATCH = issueText(issue)
  const missing = selectJointMismatch(s)
  if (missing) {
    conditions.APP_PLAN_ROBOT_MISMATCH = `规划文件中的关节在机械臂模型中没有：${missing}`
  }
  return conditions
}

export function installLocalAlarms(store: AppStore, now: () => number = Date.now): () => void {
  const sync = (s: AppState & AppActions) => {
    const next = updateLocalAlarms(s.localAlarms, localConditions(s), now())
    if (next !== s.localAlarms) s.setLocalAlarms(next)
  }
  sync(store.getState())
  return store.subscribe(sync)
}
