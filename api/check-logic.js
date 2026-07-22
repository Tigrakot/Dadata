/**
 * Общая логика проверки реквизитов (вынесена для переиспользования)
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const DADATA_API_KEY = process.env.DADATA_API_KEY;
const DADATA_SECRET = process.env.DADATA_SECRET;

const FIELDS = {
  BANK_NAME: 83,
  BIK: 87,
  INN: 88,
  KPP: 89,
  CORR_ACCOUNT: 90,
  ACCOUNT: 84,
  CHECK_RESULT: 98,
};

export default async function checkLogic(taskId, res) {
  try {
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      return res.status(403).json({ error: taskRes.error || 'No task' });
    }

    const task = taskRes.task;
    const fields = task.fields || [];
    const fieldMap = {};
    fields.forEach(f => { fieldMap[f.id] = f.value; });

    const bik = String(fieldMap[FIELDS.BIK] || '').trim();
    const bankName = String(fieldMap[FIELDS.BANK_NAME] || '').trim();
    const inn = String(fieldMap[FIELDS.INN] || '').trim();
    const kpp = String(fieldMap[FIELDS.KPP] || '').trim();
    const corrAccount = String(fieldMap[FIELDS.CORR_ACCOUNT] || '').trim();
    const account = String(fieldMap[FIELDS.ACCOUNT] || '').trim();

    if (!bik || bik.length < 9) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELDS.CHECK_RESULT, value: `⚠️ Не указан БИК` }],
        '⚠️ Не указан БИК банка. Проверка невозможна.'
      );
      return res.status(400).json({ error: 'No BIK' });
    }

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
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELDS.CHECK_RESULT, value: `❌ Ошибка DaData` }],
        `❌ Ошибка DaData: ${dadataRes.status}`
      );
      return res.status(500).json({ error: 'DaData error' });
    }

    const dadata = await dadataRes.json();

    if (!dadata.suggestions || dadata.suggestions.length === 0) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELDS.CHECK_RESULT, value: `❌ Банк не найден` }],
        `❌ Банк с БИК ${bik} не найден!`
      );
      return res.status(404).json({ error: 'Bank not found' });
    }

    const bank = dadata.suggestions[0].data;
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

    const fieldUpdates = [
      { id: FIELDS.CHECK_RESULT, value: summary },
    ];

    const pyrusResp = await addCommentWithFieldUpdate(taskId, fieldUpdates, fullComment);
    console.log(`[CHECK RESULT] task=${taskId} success=${issues.length === 0} pyrus_resp=${JSON.stringify(pyrusResp).substring(0, 200)}`);

    return res.status(200).json({
      success: issues.length === 0,
      bank_name: bank.name?.payment,
      checks,
      issues,
    });

  } catch (error) {
    console.error('[CHECK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
