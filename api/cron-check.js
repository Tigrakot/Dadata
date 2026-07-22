/**
 * Cron endpoint — дёргается cron-job.org каждые 1-2 мин
 * Находит задачи в форме 1530544 с пустым полем 98
 * Запускает проверку реквизитов через runBankCheck
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';
import { runBankCheck } from './_bank-check.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  // Защита от случайного вызова (опционально)
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[CRON] start check');

    // Получаем все задачи формы
    const formId = 1530544;
    const listRes = await pyrusRequest(`/forms/${formId}/register`);

    const tasks = listRes.tasks || [];
    console.log(`[CRON] found ${tasks.length} tasks`);

    const results = [];

    for (const taskSummary of tasks) {
      const taskId = taskSummary.id;

      // Проверяем наличие поля 98 уже в реестре (быстрый отсев)
      const fieldMap = {};
      (taskSummary.fields || []).forEach(f => { fieldMap[f.id] = f.value; });

      // Пропускаем если уже проверено
      if (fieldMap[98]) {
        results.push({ task_id: taskId, skipped: 'already checked' });
        continue;
      }

      // Проверяем наличие БИК (быстрый отсев)
      const bik = String(fieldMap[87] || '').trim();
      if (!bik || bik.length < 9) {
        results.push({ task_id: taskId, skipped: 'no BIK' });
        continue;
      }

      console.log(`[CRON] checking task=${taskId} BIK=${bik}`);

      const result = await runBankCheck(taskId, { pyrusRequest, addCommentWithFieldUpdate });
      results.push({ task_id: taskId, ok: result.ok, success: result.success, ...(result.error && { error: result.error }) });
    }

    const checked = results.filter(r => r.ok).length;
    const skipped = results.filter(r => r.skipped).length;
    const errors = results.filter(r => r.error).length;
    console.log(`[CRON] done: checked=${checked} skipped=${skipped} errors=${errors}`);

    return res.status(200).json({
      total: tasks.length,
      checked,
      skipped,
      errors,
      results,
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
