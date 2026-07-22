/**
 * Общая логика проверки реквизитов банка через DaData
 * Используется в check-requisites.js, cron-check.js, pyrus-webhook.js
 *
 * Проверяет:
 * - Название банка (совпадение с DaData)
 * - Корр. счёт
 * - ИНН
 * - КПП
 * - Статус банка (ACTIVE)
 * - БИК головного офиса (филиалы отсеиваются)
 * - SWIFT
 * - Регистрационный номер ЦБ
 * - Дата регистрации
 * - Адрес головного офиса (если в задаче не указан)
 * - Тип учреждения (Банк / НКО / Филиал)
 * - Статус лицензии
 */

const DADATA_API_KEY = process.env.DADATA_API_KEY;
const DADATA_SECRET = process.env.DADATA_SECRET;

// Поля формы 1530544
export const FIELDS = {
  BANK_NAME: 83,
  BANK_ADDRESS: 86,
  BIK: 87,
  INN: 88,
  KPP: 89,
  CORR_ACCOUNT: 90,
  ACCOUNT: 84,
  CHECK_RESULT: 98,
};

/**
 * Основная функция проверки
 * @param {number} taskId - ID задачи Pyrus
 * @param {object} deps - { pyrusRequest, addCommentWithFieldUpdate }
 * @returns {Promise<{ok, success, bankName, checks, issues, error?, status?}>}
 */
export async function runBankCheck(taskId, { pyrusRequest, addCommentWithFieldUpdate }) {
  const taskRes = await pyrusRequest(`/tasks/${taskId}`);
  if (taskRes.error || !taskRes.task) {
    return { ok: false, status: 403, error: taskRes.error || 'No task' };
  }

  const task = taskRes.task;
  const fields = task.fields || [];
  const fieldMap = {};
  fields.forEach(f => { fieldMap[f.id] = f.value; });

  const bik = String(fieldMap[FIELDS.BIK] || '').trim();
  const bankName = String(fieldMap[FIELDS.BANK_NAME] || '').trim();
  const bankAddress = String(fieldMap[FIELDS.BANK_ADDRESS] || '').trim();
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
    return { ok: false, status: 400, error: 'No BIK' };
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
    await addCommentWithFieldUpdate(
      taskId,
      [{ id: FIELDS.CHECK_RESULT, value: `❌ Ошибка DaData` }],
      `❌ Ошибка DaData: ${dadataRes.status}\n${errText.substring(0, 200)}`
    );
    return { ok: false, status: 500, error: 'DaData error' };
  }

  const dadata = await dadataRes.json();

  if (!dadata.suggestions || dadata.suggestions.length === 0) {
    await addCommentWithFieldUpdate(
      taskId,
      [{ id: FIELDS.CHECK_RESULT, value: `❌ Банк не найден` }],
      `❌ Банк с БИК ${bik} не найден в справочнике ЦБ РФ!`
    );
    return { ok: false, status: 404, error: 'Bank not found' };
  }

  const bank = dadata.suggestions[0].data;
  const checks = [];
  const issues = [];

  // 1. Название банка
  if (bankName && bank.name?.payment) {
    const dadataName = bank.name.payment.toLowerCase();
    const userFirst = bankName.toLowerCase().split(' ')[0];
    const dadataFirst = dadataName.split(' ')[0];
    if (dadataFirst.includes(userFirst) || userFirst.includes(dadataFirst) || dadataFirst === userFirst) {
      checks.push(`✅ Название: ${bank.name.payment}`);
    } else {
      issues.push(`❌ Название: "${bankName}" ≠ "${bank.name.payment}"`);
    }
  }

  // 2. Корр. счёт
  if (corrAccount && bank.correspondent_account) {
    if (corrAccount === bank.correspondent_account) {
      checks.push(`✅ Корр: ${bank.correspondent_account}`);
    } else {
      issues.push(`❌ Корр: ${corrAccount} ≠ ${bank.correspondent_account}`);
    }
  }

  // 3. ИНН
  if (inn && bank.inn) {
    if (inn === bank.inn) {
      checks.push(`✅ ИНН: ${bank.inn}`);
    } else {
      issues.push(`❌ ИНН: ${inn} ≠ ${bank.inn}`);
    }
  }

  // 4. КПП
  if (kpp && bank.kpp) {
    if (kpp === bank.kpp) {
      checks.push(`✅ КПП: ${bank.kpp}`);
    } else {
      issues.push(`⚠️ КПП: ${kpp} ≠ ${bank.kpp}`);
    }
  }

  // 5. Статус банка
  if (bank.state?.status === 'ACTIVE') {
    checks.push(`✅ Банк действующий`);
  } else if (bank.state?.status) {
    issues.push(`❌ Банк не действующий: ${bank.state.status}`);
  }

  // 6. БИК головного офиса
  if (bank.bic) {
    if (bik === bank.bic) {
      checks.push(`✅ БИК головного офиса: ${bank.bic}`);
    } else {
      issues.push(`⚠️ Указан БИК ${bik} (возможно филиал). Головной офис: ${bank.bic}`);
    }
  }

  // 7. SWIFT
  if (bank.swift) {
    checks.push(`ℹ️ SWIFT: ${bank.swift}`);
  } else {
    checks.push(`ℹ️ SWIFT: не указан (только рубли)`);
  }

  // 8. Регистрационный номер ЦБ РФ
  if (bank.registration_number) {
    checks.push(`ℹ️ Рег. номер ЦБ: ${bank.registration_number}`);
  }

  // 9. Дата регистрации
  if (bank.state?.registration_date) {
    const regDate = new Date(bank.state.registration_date);
    const regDateStr = regDate.toLocaleDateString('ru-RU');
    const ageYears = Math.floor((Date.now() - regDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (ageYears < 1) {
      issues.push(`⚠️ Банк зарегистрирован ${regDateStr} — менее 1 года назад`);
    } else {
      checks.push(`ℹ️ Дата регистрации: ${regDateStr} (${ageYears} лет назад)`);
    }
  }

  // 10. Адрес головного офиса (если в задаче не указан)
  if (bank.address?.value) {
    if (!bankAddress) {
      checks.push(`ℹ️ Адрес: ${bank.address.value}`);
    } else {
      checks.push(`ℹ️ Адрес: ${bankAddress}`);
    }
  }

  // 11. Тип учреждения
  if (bank.opf?.type) {
    if (bank.opf.type === 'BANK') {
      checks.push(`✅ Тип: Банк`);
    } else if (bank.opf.type === 'BRANCH') {
      issues.push(`⚠️ Тип: Филиал (не головной банк)`);
    } else if (bank.opf.type === 'NKO') {
      issues.push(`⚠️ Тип: Небанковская кредитная организация (НКО)`);
    } else {
      checks.push(`ℹ️ Тип: ${bank.opf.full || bank.opf.type}`);
    }
  }

  // 12. Статус лицензии
  if (bank.state?.licensing?.license_status) {
    if (bank.state.licensing.license_status === 'ACTIVE') {
      checks.push(`✅ Лицензия активна`);
    } else {
      issues.push(`❌ Лицензия: ${bank.state.licensing.license_status}`);
    }
  }

  // Счёт
  if (account) {
    checks.push(`ℹ️ Счёт: ${account}`);
  }

  // Формируем комментарий
  const header = `🏦 Проверка реквизитов по БИК ${bik}`;
  const checksText = checks.length > 0 ? `\n\n${checks.join('\n')}` : '';
  const issuesText = issues.length > 0 ? `\n\n⚠️ Проблемы:\n${issues.join('\n')}` : '';
  const footer = issues.length === 0
    ? `\n\n✅ ВСЕ РЕКВИЗИТЫ КОРРЕКТНЫ`
    : `\n\n❌ ТРЕБУЕТСЯ ПРОВЕРКА (есть предупреждения)`;
  const fullComment = header + checksText + issuesText + footer;

  // Сводка в поле 98
  const summary = issues.length === 0
    ? `✅ OK — ${new Date().toLocaleString('ru-RU')}\n${bank.name?.payment || ''}\nБИК: ${bik}${bank.swift ? `\nSWIFT: ${bank.swift}` : ''}`
    : `⚠️ ${issues.length} предупр.\n${issues.map(i => i.split('\n')[0].slice(0, 60)).join('; ')}\n${new Date().toLocaleString('ru-RU')}`;

  await addCommentWithFieldUpdate(
    taskId,
    [{ id: FIELDS.CHECK_RESULT, value: summary }],
    fullComment
  );

  return {
    ok: true,
    success: issues.length === 0,
    bankName: bank.name?.payment,
    checks,
    issues,
  };
}
