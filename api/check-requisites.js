/**
 * DaData: проверка реквизитов банка
 * POST { task_id }
 * Записывает результат в поле 98 "Проверка реквизитов" + комментарий
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';
import { runBankCheck } from './_bank-check.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    const result = await runBankCheck(taskId, { pyrusRequest, addCommentWithFieldUpdate });
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    return res.status(200).json({
      success: result.success,
      bank_name: result.bankName,
      checks: result.checks,
      issues: result.issues,
    });
  } catch (error) {
    console.error('[CHECK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
