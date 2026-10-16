/**
 * routes.ts — the local API's endpoints: tasks go to the service; topics, notify and
 * send need Telegram, so the bridge supplies those handlers.
 */
import { fail, reply, type ApiReply, type Route, type Scope } from './api'
import { taskView, type Result, type TaskService } from './service'

export interface BridgeHandlers {
  listTopics(scope: Scope): Promise<ApiReply> | ApiReply
  createTopic(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  updateTopic(scope: Scope, topic: string, body: any): Promise<ApiReply> | ApiReply
  notify(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  send(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  ask(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  approve(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  handoff(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  propose(scope: Scope, body: any): Promise<ApiReply> | ApiReply
}

const out = <T>(r: Result<T>, view: (v: T) => unknown = v => v): ApiReply =>
  r.ok ? reply(r.status ?? 200, view(r.value)) : fail(r.status, r.error)

export function taskRoutes(svc: TaskService, bridge: BridgeHandlers): Route[] {
  return [
    { method: 'POST', path: '/v1/tasks', handler: (s, q) => out(svc.create(s, q.body), v => ({
      task: taskView(v.task), duplicate: !!v.duplicate,
      message: v.duplicate
        ? 'An identical task already exists here, so nothing new was created. Tell the person it is already set up.'
        : 'Created. The bot has posted the task\'s card in the chat with its details and buttons; keep your reply to one short line.',
    })) },
    { method: 'GET', path: '/v1/tasks', handler: (s, q) => out(svc.list(s, (q.query.get('where') as any) || undefined, q.query.get('chat') || undefined), v => ({ tasks: v })) },
    { method: 'GET', path: '/v1/tasks/:id', handler: (s, q) => out(svc.get(s, q.params.id), v => ({ task: v })) },
    { method: 'PATCH', path: '/v1/tasks/:id', handler: (s, q) => out(svc.update(s, q.params.id, q.body), v => ({ task: taskView(v.task), message: 'Updated; its card has been edited.' })) },
    { method: 'DELETE', path: '/v1/tasks/:id', handler: (s, q) => out(svc.remove(s, q.params.id), v => ({ task: taskView(v.task), message: 'Deleted.' })) },
    { method: 'POST', path: '/v1/tasks/:id/pause', handler: (s, q) => out(svc.pause(s, q.params.id), v => ({ task: taskView(v.task), message: 'Paused.' })) },
    { method: 'POST', path: '/v1/tasks/:id/resume', handler: (s, q) => out(svc.resume(s, q.params.id), v => ({ task: taskView(v.task), message: 'Resumed.' })) },
    { method: 'POST', path: '/v1/tasks/:id/run', handler: async (s, q) => out(await svc.runNow(s, q.params.id), v => ({ ...v, message: 'Started.' })) },
    { method: 'POST', path: '/v1/tasks/:id/done', handler: (s, q) => (q.params.id === 'self' || q.params.id === s.taskId)
      ? out(svc.done(s), v => ({ task: taskView(v.task), message: 'Finished: this task will not run again.' }))
      : fail(403, 'a run can only finish its own task') },
    { method: 'POST', path: '/v1/report', handler: (s, q) => out(svc.report(s, q.body), () => ({ recorded: true })) },
    { method: 'POST', path: '/v1/notify', handler: (s, q) => bridge.notify(s, q.body) },
    { method: 'POST', path: '/v1/ask', handler: (s, q) => bridge.ask(s, q.body) },
    { method: 'POST', path: '/v1/approve', handler: (s, q) => bridge.approve(s, q.body) },
    { method: 'POST', path: '/v1/handoff', handler: (s, q) => bridge.handoff(s, q.body) },
    { method: 'POST', path: '/v1/tasks/propose', handler: (s, q) => bridge.propose(s, q.body) },
    { method: 'GET', path: '/v1/topics', handler: s => bridge.listTopics(s) },
    { method: 'POST', path: '/v1/topics', handler: (s, q) => bridge.createTopic(s, q.body) },
    { method: 'PATCH', path: '/v1/topics/:topic', handler: (s, q) => bridge.updateTopic(s, q.params.topic, q.body) },
    { method: 'POST', path: '/v1/send', handler: (s, q) => bridge.send(s, q.body) },
  ]
}
