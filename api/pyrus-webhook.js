/**
 * Webhook от Pyrus → проверка реквизитов
 * Формат: бот-инбокс notification
 * { event: "task.created" | "comment", task_id, user_id, task: {...} }
 */

import checkLogic from './check-logic.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;
  const event = data.event;

  console.log(`[WEBHOOK] event=${event} task=${taskId}`);

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  // Только при создании задачи (как просил юзер — при создании, не от статуса)
  if (event && event !== 'task.created' && event !== 'create') {
    return res.status(200).json({ skipped: true, reason: `event=${event}` });
  }

  return checkLogic(taskId, res);
}
