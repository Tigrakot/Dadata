/**
 * Webhook от Pyrus → проверка реквизитов
 * Формат: бот-инбокс notification
 * { event: "task.created" | "comment", task_id, user_id, task: {...} }
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';
import { runBankCheck } from './_bank-check.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'dadata-mu' });
  }

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

  // Только при создании задачи
  if (event && event !== 'task.created' && event !== 'create') {
    return res.status(200).json({ skipped: true, reason: `event=${event}` });
  }

  try {
    const result = await runBankCheck(taskId, { pyrusRequest, addCommentWithFieldUpdate });
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    return res.status(200).json({
      success: result.success,
      bank_name: result.bankName,
    });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
