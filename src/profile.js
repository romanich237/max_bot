const CYRILLIC_LETTERS = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';

function nextDisplayName(options = {}, index = 0) {
  const { mode = 'letter', baseName = '', names = [] } = options;

  if (mode === 'list' && names.length > 0) {
    return names[index % names.length];
  }

  const letter = CYRILLIC_LETTERS[index % CYRILLIC_LETTERS.length];
  return baseName ? `${baseName}${letter}` : letter;
}

async function clickSettings(page) {
  const settings = page.getByRole('button', { name: /^settings$/i });
  if (await settings.isVisible({ timeout: 3000 }).catch(() => false)) {
    await settings.click();
    return;
  }

  const settingsRu = page.getByRole('button', { name: /настройки/i });
  await settingsRu.click({ timeout: 10000 });
}

async function openProfileEditor(page) {
  const profilePanel = page.locator('div.panel div.section div.input').first();
  if (await profilePanel.isVisible({ timeout: 1500 }).catch(() => false)) {
    return;
  }

  const editProfile = page.getByRole('main', { name: /edit profile/i });
  if (await editProfile.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  await clickSettings(page);
  await page.waitForTimeout(500);

  const profileBtn = page
    .locator('button')
    .filter({ hasText: /\+\d[\d\s\-()]{8,}/ })
    .first();

  await profileBtn.click({ timeout: 10000 });
  await page
    .locator('div.panel div.section div.input, main[name*="edit profile" i]')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

async function getProfileSectionInput(page, sectionIndex) {
  const section = page.locator('div.panel div.section').nth(sectionIndex);
  const input = section.locator('input:not([type="hidden"]), textarea').first();

  if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
    return input;
  }

  const textbox = section.getByRole('textbox').first();
  if (await textbox.isVisible({ timeout: 1500 }).catch(() => false)) {
    return textbox;
  }

  return null;
}

async function readInputValue(input) {
  if (!input) return '';

  try {
    const value = (await input.inputValue()).trim();
    if (value) return value;
  } catch {
    /* not a regular input */
  }

  try {
    return (await input.innerText()).trim();
  } catch {
    return '';
  }
}

async function readProfileNames(page, chatUrl) {
  await openProfileEditor(page);
  await page.waitForTimeout(400);

  let firstName = '';
  let lastName = '';

  const firstByRole = page.getByRole('textbox', { name: /^(first name|имя)$/i }).first();
  const lastByRole = page.getByRole('textbox', { name: /^(last name|фамилия)$/i }).first();

  if (await firstByRole.isVisible({ timeout: 1500 }).catch(() => false)) {
    firstName = await readInputValue(firstByRole);
  }
  if (await lastByRole.isVisible({ timeout: 1500 }).catch(() => false)) {
    lastName = await readInputValue(lastByRole);
  }

  if (!firstName) {
    firstName = await readInputValue(await getProfileSectionInput(page, 0));
  }
  if (!lastName) {
    lastName = await readInputValue(await getProfileSectionInput(page, 1));
  }

  await closeProfileEditor(page);

  if (chatUrl) {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();

  return {
    firstName,
    lastName,
    displayName: displayName || firstName,
  };
}

async function readProfileFirstName(page, chatUrl) {
  const { displayName, firstName } = await readProfileNames(page, chatUrl);
  return displayName || firstName;
}

async function saveFirstName(page, firstName) {
  let input = await getProfileSectionInput(page, 0);
  if (!input) {
    input = page.getByRole('textbox', { name: /^(first name|имя)$/i }).first();
  }

  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click();
  await input.fill(firstName);
  await input.blur();
  await page.waitForTimeout(300);

  const saveBtn = page.getByRole('button', { name: /^(save|сохранить)$/i });
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await saveBtn.click();

  await page
    .getByRole('button', { name: /^(save|сохранить)$/i })
    .waitFor({ state: 'hidden', timeout: 15000 })
    .catch(() => {});

  const error = page.getByText(/only letters allowed|только буквы/i);
  if (await error.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error('MAX принимает только буквы в имени');
  }

  await page.waitForTimeout(800);
}

async function closeProfileEditor(page) {
  const back = page.getByRole('button', { name: /^(go back|назад)$/i });
  if (await back.isVisible({ timeout: 2000 }).catch(() => false)) {
    await back.click();
    await page.waitForTimeout(400);
  }

  const chats = page.getByRole('button', { name: /^(chats|чаты)$/i });
  if (await chats.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chats.click();
    await page.waitForTimeout(400);
  }
}

async function rotateDisplayName(page, chatUrl, options = {}) {
  const firstName = nextDisplayName(options, options._index ?? 0);
  console.log(`Смена имени в MAX → «${firstName}»`);

  await openProfileEditor(page);
  await saveFirstName(page, firstName);
  await closeProfileEditor(page);

  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);

  return firstName;
}

module.exports = {
  nextDisplayName,
  readProfileFirstName,
  readProfileNames,
  rotateDisplayName,
};
