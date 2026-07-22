/**
 * Cron endpoint — дёргается cron-job.org каждые 1-2 мин
 * Находит задачи в форме 1530544 со статусом "🟡 На выплату" и пустым полем 98
 * Запускает проверку реквизитов для каждой
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const DADATA_API_KEY = process.env.DADATA_API_KEY;
const DADATA_SECRET = process.env.DADATA_SECRET;

const FIELDS = {
  BIK: 87,
  INN: 88,
  KPP: 89,
  CORR_ACCOUNT: 90,
  ACCOUNT: 84,
  BANK_NAME: 83,
  CHECK_RESULT: 98,
};

// ID статуса "🟡 На выплату" в форме 1530544
const STATUS_PAYOUT = 2;

export default async function handler(req, res) {
  // Защита от случайного вызова (опционально)
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[CRON] start check');

    // Получаем все задачи формы (cron сам отфильтрует те, где пустое поле 98)
    const formId = 1530544;
    const listRes = await pyrusRequest(`/forms/${formId}/register`);

    const tasks = listRes.tasks || [];
    console.log(`[CRON] found ${tasks.length} tasks total`);

    const results = [];

    for (const taskSummary of tasks) {
      const taskId = taskSummary.id;

      // Получаем полную задачу (со всеми полями)
      const taskRes = await pyrusRequest(`/tasks/${taskId}`);
      if (taskRes.error || !taskRes.task) {
        results.push({ task_id: taskId, skipped: 'no access' });
        continue;
      }

      const task = taskRes.task;
      const fieldMap = {};
      (task.fields || []).forEach(f => { fieldMap[f.id] = f.value; });

      // Пропускаем если уже проверено
      if (fieldMap[FIELDS.CHECK_RESULT]) {
        results.push({ task_id: taskId, skipped: 'already checked' });
        continue;
      }

      // Проверяем что есть БИК
      const bik = String(fieldMap[FIELDS.BIK] || '').trim();
      if (!bik || bik.length < 9) {
        results.push({ task_id: taskId, skipped: 'no BIK' });
        continue;
      }

      console.log(`[CRON] checking task=${taskId} BIK=${bik}`);

      // DaData запрос
      const dadataRes = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/bank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Token ${DADATA_API_KEY}`,
          'X-Secret': DADATA_SECRET,
        },
        body: JSON.stringify({ query: bik }),
      });

      if (!dadataRes.ok) {
        results.push({ task_id: taskId, error: `DaData ${dadataRes.status}` });
        continue;
      }

      const dadata = await dadataRes.json();
      if (!dadata.suggestions || dadata.suggestions.length === 0) {
        await addCommentWithFieldUpdate(
          taskId,
          [{ id: FIELDS.CHECK_RESULT, value: `❌ Банк не найден` }],
          `❌ Банк с БИК ${bik} не найден в справочнике ЦБ РФ!`
        );
        results.push({ task_id: taskId, error: 'bank not found' });
        continue;
      }

      const bank = dadata.suggestions[0].data;
      const bankName = String(fieldMap[FIELDS.BANK_NAME] || '').trim();
      const inn = String(fieldMap[FIELDS.INN] || '').trim();
      const kpp = String(fieldMap[FIELDS.KPP] || '').trim();
      const corrAccount = String(fieldMap[FIELDS.CORR_ACCOUNT] || '').trim();
      const account = String(fieldMap[FIELDS.ACCOUNT] || '').trim();

      const checks = [];
      const issues = [];

      if (bankName && bank.name?.payment) {
        const dadataName = bank.name.payment.toLowerCase();
        const userFirst = bankName.toLowerCase().split(' ')[0];
        const dadataFirst = dadataName.split(' ')[0];
        if (dadataFirst.includes(userFirst) || userFirst.includes(dadataFirst) || dadataFirst === userFirst) {
          checks.push(`✅ ${bank.name.payment}`);
        } else {
          issues.push(`❌ Название: "${bankName}" ≠ "${bank.name.payment}"`);
        }
      }

      if (corrAccount && bank.correspondent_account) {
        if (corrAccount === bank.correspondent_account) {
          checks.push(`✅ Корр: ${bank.correspondent_account}`);
        } else {
          issues.push(`❌ Корр: ${corrAccount} ≠ ${bank.correspondent_account}`);
        }
      }

      if (inn && bank.inn) {
        if (inn === bank.inn) {
          checks.push(`✅ ИНН: ${bank.inn}`);
        } else {
          issues.push(`❌ ИНН: ${inn} ≠ ${bank.inn}`);
        }
      }

      if (kpp && bank.kpp) {
        if (kpp === bank.kpp) {
          checks.push(`✅ КПП: ${bank.kpp}`);
        } else {
          issues.push(`⚠️ КПП: ${kpp} ≠ ${bank.kpp}`);
        }
      }

      if (bank.state?.status === 'ACTIVE') {
        checks.push(`✅ Банк действующий`);
      } else if (bank.state?.status) {
        issues.push(`❌ Банк не действующий: ${bank.state.status}`);
      }

      if (account) {
        checks.push(`ℹ️ Счёт: ${account}`);
      }

      const header = `🏦 Проверка реквизитов по БИК ${bik}`;
      const checksText = checks.length > 0 ? `\n\n${checks.join('\n')}` : '';
      const issuesText = issues.length > 0 ? `\n\n⚠️ Проблемы:\n${issues.join('\n')}` : '';
      const footer = issues.length === 0 ? `\n\n✅ ВСЕ РЕКВИЗИТЫ КОРРЕКТНЫ` : `\n\n❌ ТРЕБУЕТСЯ ИСПРАВЛЕНИЕ`;
      const fullComment = header + checksText + issuesText + footer;

      const summary = issues.length === 0
        ? `✅ OK — ${new Date().toLocaleString('ru-RU')}\n${bank.name?.payment || ''}\nБИК: ${bik}`
        : `❌ ${issues.length} ошибок\n${issues.map(i => i.split('\n')[0].slice(0, 50)).join('; ')}\n${new Date().toLocaleString('ru-RU')}`;

      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELDS.CHECK_RESULT, value: summary }],
        fullComment
      );

      results.push({ task_id: taskId, success: issues.length === 0, issues: issues.length });
    }

    console.log(`[CRON] done: ${JSON.stringify(results)}`);

    return res.status(200).json({
      checked: results.filter(r => r.success !== undefined).length,
      skipped: results.filter(r => r.skipped).length,
      results,
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
