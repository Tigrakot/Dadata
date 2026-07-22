/**
 * Webhook от Pyrus → проверка реквизитов
 * Срабатывает при создании/изменении задачи
 */

import { checkLogic } from './check-logic.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  // Всегда проверяем (без проверки статуса)
  return checkLogic(taskId, res);
}
