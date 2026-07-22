/**
 * Проверка реквизитов банка через DaData
 * POST /api/check-requisites { task_id: "..." }
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const DADATA_API_KEY = process.env.DADATA_API_KEY;
const DADATA_SECRET = process.env.DADATA_SECRET;

// Поля формы 1530544 - "Форма для проекта ДЦ"
const FIELDS = {
  BANK_NAME: 83,
  BANK_FULL_NAME: 85,
  BANK_ADDRESS: 86,
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

    const bik = String(fieldMap[FIELDS.BIK] || '').trim();
    const bankName = String(fieldMap[FIELDS.BANK_NAME] || '').trim();
    const inn = String(fieldMap[FIELDS.INN] || '').trim();
    const kpp = String(fieldMap[FIELDS.KPP] || '').trim();
    const corrAccount = String(fieldMap[FIELDS.CORR_ACCOUNT] || '').trim();
    const account = String(fieldMap[FIELDS.ACCOUNT] || '').trim();

    if (!bik || bik.length < 9) {
      await addCommentWithFieldUpdate(taskId, [], `❌ Не указан БИК банка. Проверка невозможна.`);
      return res.status(400).json({ error: 'No BIK' });
    }

    // Запрос в DaData
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
      const errText = await dadataRes.text();
      await addCommentWithFieldUpdate(taskId, [], `❌ Ошибка DaData API: ${dadataRes.status} ${errText.substring(0, 200)}`);
      return res.status(500).json({ error: 'DaData error', details: errText });
    }

    const dadata = await dadataRes.json();

    if (!dadata.suggestions || dadata.suggestions.length === 0) {
      await addCommentWithFieldUpdate(taskId, [], `❌ Банк с БИК ${bik} не найден в справочнике ЦБ РФ!`);
      return res.status(404).json({ error: 'Bank not found' });
    }

    const bank = dadata.suggestions[0].data;
    const checks = [];
    const issues = [];

    // 1. Название банка
    if (bankName && bank.name?.payment) {
      const dadataName = bank.name.payment.toLowerCase();
      const userName = bankName.toLowerCase();
      const userFirstWord = userName.split(' ')[0];
      const dadataFirstWord = dadataName.split(' ')[0];
      if (dadataFirstWord.includes(userFirstWord) || userFirstWord.includes(dadataFirstWord) ||
          dadataFirstWord === userFirstWord) {
        checks.push(`✅ Название: ${bank.name.payment}`);
      } else {
        issues.push(`❌ Название не совпадает:\n   Введено: "${bankName}"\n   По БИК: "${bank.name.payment}"`);
      }
    }

    // 2. Корр. счёт
    if (corrAccount && bank.correspondent_account) {
      if (corrAccount === bank.correspondent_account) {
        checks.push(`✅ Корр. счёт: ${bank.correspondent_account}`);
      } else {
        issues.push(`❌ Корр. счёт не совпадает:\n   Введено: ${corrAccount}\n   По БИК: ${bank.correspondent_account}`);
      }
    }

    // 3. ИНН банка
    if (inn && bank.inn) {
      if (inn === bank.inn) {
        checks.push(`✅ ИНН: ${bank.inn}`);
      } else {
        issues.push(`❌ ИНН банка не совпадает:\n   Введено: ${inn}\n   По БИК: ${bank.inn}`);
      }
    }

    // 4. КПП банка
    if (kpp && bank.kpp) {
      if (kpp === bank.kpp) {
        checks.push(`✅ КПП: ${bank.kpp}`);
      } else {
        issues.push(`⚠️ КПП не совпадает:\n   Введено: ${kpp}\n   По БИК: ${bank.kpp}`);
      }
    }

    // 5. Статус банка
    if (bank.state?.status && bank.state.status !== 'ACTIVE') {
      issues.push(`❌ Банк не действующий! Статус: ${bank.state.status} (${bank.state.registration_number || ''})`);
    } else if (bank.state?.status === 'ACTIVE') {
      checks.push(`✅ Банк действующий`);
    }

    // 6. Информация о счёте
    if (account && bik && account.length >= 5) {
      // Проверка по правилу: 7-9 цифра БИК должна быть в позиции 7-9 счёта (для расч. счетов)
      const accountDigits = account.replace(/\D/g, '');
      const bikDigits = bik.replace(/\D/g, '');
      if (accountDigits.length >= 5) {
        checks.push(`ℹ️ Счёт: ${account}`);
      }
    }

    // Формируем комментарий
    const header = `🏦 **Проверка реквизитов по БИК ${bik}**`;
    const checksText = checks.length > 0 ? `\n\n**Проверки:**\n${checks.join('\n')}` : '';
    const issuesText = issues.length > 0 ? `\n\n**⚠️ Проблемы:**\n${issues.join('\n\n')}` : '';
    const footer = issues.length === 0
      ? `\n\n✅ **ВСЕ РЕКВИЗИТЫ КОРРЕКТНЫ** — можно делать выплату!`
      : `\n\n❌ **ТРЕБУЕТСЯ ИСПРАВЛЕНИЕ РЕКВИЗИТОВ**`;

    const fullComment = header + checksText + issuesText + footer;

    // Обновляем статус задачи
    const fieldUpdates = issues.length > 0
      ? [{ id: FIELDS.STATUS, value: '❌ Реквизиты неверны' }]
      : [{ id: FIELDS.STATUS, value: '✅ Реквизиты проверены' }];

    await addCommentWithFieldUpdate(taskId, fieldUpdates, fullComment);

    return res.status(200).json({
      success: issues.length === 0,
      bank_name: bank.name?.payment,
      bik: bank.bic,
      corr_account: bank.correspondent_account,
      inn: bank.inn,
      kpp: bank.kpp,
      status: bank.state?.status,
      checks,
      issues,
    });

  } catch (error) {
    console.error('[CHECK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}
