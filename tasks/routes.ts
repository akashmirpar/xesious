/**
 * routes.ts — the local API's endpoints: tasks go to the service; topics, notify and
 * send need Telegram, so the bridge supplies those handlers.
 */
import { fail, reply, type ApiReply, type Route, type Scope } from './api'
import { taskView, type Result, type TaskService } from './service'

export interface BridgeHandlers {
  listTopics(scope: Scope): Promise<ApiReply> | ApiReply
  peekTopic(scope: Scope, topic: string, messages?: number): Promise<ApiReply> | ApiReply
  createTopic(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  updateTopic(scope: Scope, topic: string, body: any): Promise<ApiReply> | ApiReply
  notify(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  send(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  ask(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  approve(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  handoff(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  propose(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  run(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  liveTurn(scope: Scope, body: any, signal?: AbortSignal): Promise<ApiReply> | ApiReply
  liveEvents(scope: Scope, query: URLSearchParams, signal?: AbortSignal): Promise<ApiReply> | ApiReply
  liveTopics(scope: Scope, query: URLSearchParams): Promise<ApiReply> | ApiReply
  liveMessages(scope: Scope, query: URLSearchParams): Promise<ApiReply> | ApiReply
  liveSay(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  livePhoto(scope: Scope, query: URLSearchParams): Promise<ApiReply> | ApiReply
  showTopic(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  liveVoice(scope: Scope, query: URLSearchParams): Promise<ApiReply> | ApiReply
  playAnswer(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  callMode(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  liveAnswer(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  liveStop(scope: Scope, body: any): Promise<ApiReply> | ApiReply
  answerWaitTool(scope: Scope, id: string, body: any): Promise<ApiReply> | ApiReply
  stopTopicTool(scope: Scope, topic: string): Promise<ApiReply> | ApiReply
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
    { method: 'POST', path: '/v1/tasks/:id/fire', handler: (s, q) => out(svc.fire(s, q.params.id, q.body?.payload), v => ({ ...v, message: 'Fired: it runs now, given the payload.' })) },
    { method: 'POST', path: '/v1/run', operatorOnly: true, handler: (s, q) => bridge.run(s, q.body) },
    // A turn said on a topic's live call, streamed back to the live server as it runs.
    { method: 'POST', path: '/v1/live/turn', operatorOnly: true, handler: (s, q) => bridge.liveTurn(s, q.body, q.signal) },
    // What is running in that call's group, streamed while the page is open.
    { method: 'GET', path: '/v1/live/events', operatorOnly: true, handler: (s, q) => bridge.liveEvents(s, q.query, q.signal) },
    // That group's topics and what each is doing, for the page's list.
    { method: 'GET', path: '/v1/live/topics', operatorOnly: true, handler: (s, q) => bridge.liveTopics(s, q.query) },
    // One topic's latest messages, and typing into it, from the page.
    { method: 'GET', path: '/v1/live/messages', operatorOnly: true, handler: (s, q) => bridge.liveMessages(s, q.query) },
    { method: 'POST', path: '/v1/live/say', operatorOnly: true, handler: (s, q) => bridge.liveSay(s, q.body) },
    { method: 'GET', path: '/v1/live/photo', operatorOnly: true, handler: (s, q) => bridge.livePhoto(s, q.query) },
    // The front desk opening a topic on the person's live page.
    { method: 'POST', path: '/v1/live/show', handler: (s, q) => bridge.showTopic(s, q.body) },
    { method: 'GET', path: '/v1/live/voice', operatorOnly: true, handler: (s, q) => bridge.liveVoice(s, q.query) },
    { method: 'POST', path: '/v1/live/play', handler: (s, q) => bridge.playAnswer(s, q.body) },
    { method: 'POST', path: '/v1/live/mode', handler: (s, q) => bridge.callMode(s, q.body) },
    // Answering what waits on the person, and stopping a run: from the page, and by the
    // front desk on the call.
    { method: 'POST', path: '/v1/live/answer', operatorOnly: true, handler: (s, q) => bridge.liveAnswer(s, q.body) },
    { method: 'POST', path: '/v1/live/stop', operatorOnly: true, handler: (s, q) => bridge.liveStop(s, q.body) },
    { method: 'POST', path: '/v1/waits/:id/answer', handler: (s, q) => bridge.answerWaitTool(s, q.params.id, q.body) },
    { method: 'POST', path: '/v1/topics/:topic/stop', handler: (s, q) => bridge.stopTopicTool(s, q.params.topic) },
    { method: 'GET', path: '/v1/topics', handler: s => bridge.listTopics(s) },
    { method: 'GET', path: '/v1/topics/:topic/peek', handler: (s, q) => bridge.peekTopic(s, q.params.topic, q.query.get('messages') ? Number(q.query.get('messages')) : undefined) },
    { method: 'POST', path: '/v1/topics', handler: (s, q) => bridge.createTopic(s, q.body) },
    { method: 'PATCH', path: '/v1/topics/:topic', handler: (s, q) => bridge.updateTopic(s, q.params.topic, q.body) },
    { method: 'POST', path: '/v1/send', handler: (s, q) => bridge.send(s, q.body) },
  ]
}
