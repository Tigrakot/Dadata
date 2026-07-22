/**
 * Webhook от Pyrus → DaData проверка реквизитов
 * Вызывается автоматически когда задача переходит в "На выплату"
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const DADATA_API_KEY = process.env.DADATA_API_KEY;
const DADATA_SECRET = process.env.DADATA_SECRET;

// Поля формы 1530544
const FIELDS = {
  BANK_NAME: 83,
  BIK: 87,
  INN: 88,
  KPP: 89,
  CORR_ACCOUNT: 90,
  ACCOUNT: 84,
  STATUS: 53,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;

  try {
    if (!taskId) {
      return res.status(400).json({ error: 'No task_id' });
    }

    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      return res.status(403).json({ error: taskRes.error || 'No task' });
    }

    const task = taskRes.task;
    const fields = task.fields || [];
    const fieldMap = {};
    fields.forEach(f => { fieldMap[f.id] = f.value; });

    // Проверяем текущий статус задачи - проверяем только если "На выплату" или похожее
    const currentStatus = String(fieldMap[FIELDS.STATUS] || '');
    const statusLower = currentStatus.toLowerCase();
    const needCheck = statusLower.includes('выплат') ||
                      statusLower.includes('проверк') ||
                      data.trigger === 'manual';

    if (!needCheck) {
      return res.status(200).json({ skipped: true, reason: 'Wrong status', status: currentStatus });
    }

    const bik = String(fieldMap[FIELDS.BIK] || '').trim();
    const bankName = String(fieldMap[FIELDS.BANK_NAME] || '').trim();
    const inn = String(fieldMap[FIELDS.INN] || '').trim();
    const kpp = String(fieldMap[FIELDS.KPP] || '').trim();
    const corrAccount = String(fieldMap[FIELDS.CORR_ACCOUNT] || '').trim();
    const account = String(fieldMap[FIELDS.ACCOUNT] || '').trim();

    if (!bik || bik.length < 9) {
      return res.status(200).json({ skipped: true, reason: 'No BIK' });
    }

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
      return res.status(500).json({ error: 'DaData error' });
    }

    const dadata = await dadataRes.json();

    if (!dadata.suggestions || dadata.suggestions.length === 0) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELDS.STATUS, value: '❌ Реквизиты неверны' }],
        `❌ Банк с БИК ${bik} не найден в справочнике ЦБ РФ!`
      );
      return res.status(200).json({ success: false, reason: 'Bank not found' });
    }

    const bank = dadata.suggestions[0].data;
    const checks = [];
    const issues = [];

    if (bankName && bank.name?.payment) {
      const dadataName = bank.name.payment.toLowerCase();
      const userFirstWord = bankName.toLowerCase().split(' ')[0];
      const dadataFirstWord = dadataName.split(' ')[0];
      if (dadataFirstWord.includes(userFirstWord) || userFirstWord.includes(dadataFirstWord) ||
          dadataFirstWord === userFirstWord) {
        checks.push(`✅ Название: ${bank.name.payment}`);
      } else {
        issues.push(`❌ Название не совпадает:\n   Введено: "${bankName}"\n   По БИК: "${bank.name.payment}"`);
      }
    }

    if (corrAccount && bank.correspondent_account) {
      if (corrAccount === bank.correspondent_account) {
        checks.push(`✅ Корр. счёт: ${bank.correspondent_account}`);
      } else {
        issues.push(`❌ Корр. счёт:\n   Введено: ${corrAccount}\n   По БИК: ${bank.correspondent_account}`);
      }
    }

    if (inn && bank.inn) {
      if (inn === bank.inn) {
        checks.push(`✅ ИНН: ${bank.inn}`);
      } else {
        issues.push(`❌ ИНН банка:\n   Введено: ${inn}\n   По БИК: ${bank.inn}`);
      }
    }

    if (kpp && bank.kpp) {
      if (kpp === bank.kpp) {
        checks.push(`✅ КПП: ${bank.kpp}`);
      } else {
        issues.push(`⚠️ КПП не совпадает:\n   Введено: ${kpp}\n   По БИК: ${bank.kpp}`);
      }
    }

    if (bank.state?.status === 'ACTIVE') {
      checks.push(`✅ Банк действующий`);
    } else if (bank.state?.status) {
      issues.push(`❌ Банк не действующий! Статус: ${bank.state.status}`);
    }

    if (account) {
      checks.push(`ℹ️ Счёт: ${account}`);
    }

    const header = `🏦 **Автоматическая проверка реквизитов по БИК ${bik}**`;
    const checksText = checks.length > 0 ? `\n\n**Проверки:**\n${checks.join('\n')}` : '';
    const issuesText = issues.length > 0 ? `\n\n**⚠️ Проблемы:**\n${issues.join('\n\n')}` : '';
    const footer = issues.length === 0
      ? `\n\n✅ **ВСЕ РЕКВИЗИТЫ КОРРЕКТНЫ** — можно делать выплату!`
      : `\n\n❌ **ТРЕБУЕТСЯ ИСПРАВЛЕНИЕ РЕКВИЗИТОВ**`;

    const fullComment = header + checksText + issuesText + footer;

    const fieldUpdates = issues.length > 0
      ? [{ id: FIELDS.STATUS, value: '❌ Реквизиты неверны' }]
      : [{ id: FIELDS.STATUS, value: '✅ Реквизиты проверены' }];

    await addCommentWithFieldUpdate(taskId, fieldUpdates, fullComment);

    return res.status(200).json({
      success: issues.length === 0,
      bank_name: bank.name?.payment,
      checks_count: checks.length,
      issues_count: issues.length,
    });

  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
