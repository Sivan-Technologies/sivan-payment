import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';
import { validateTelegramInitData } from '../src/auth/telegram-miniapp-auth.service.js';

test('validateTelegramInitData verifies authentic HMAC and rejects tampered or expired data', () => {
  const mockBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const user = {
    id: 99887766,
    first_name: 'Alex',
    username: 'alex_tma',
  };
  const authDate = Math.floor(Date.now() / 1000);
  const userStr = JSON.stringify(user);

  // Build authentic check string sorted alphabetically
  const data = [
    `auth_date=${authDate}`,
    `query_id=AAHdF6IQAAAAAN0XohDhrOrc`,
    `user=${userStr}`,
  ];
  data.sort((a, b) => a.localeCompare(b));
  const dataCheckString = data.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(mockBotToken).digest();
  const validHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const authenticInitData = `auth_date=${authDate}&query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=${encodeURIComponent(userStr)}&hash=${validHash}`;

  // 1. Authentic signature succeeds
  const validResult = validateTelegramInitData(authenticInitData, [mockBotToken]);
  assert.strictEqual(validResult.valid, true);
  assert.strictEqual(validResult.user?.id, 99887766);
  assert.strictEqual(validResult.user?.username, 'alex_tma');

  // 2. Tampered hash fails
  const tamperedInitData = `${authenticInitData}bad`;
  const invalidResult = validateTelegramInitData(tamperedInitData, [mockBotToken]);
  assert.strictEqual(invalidResult.valid, false);

  // 3. Expired auth_date (older than 24 hours) fails
  const oldDate = Math.floor(Date.now() / 1000) - 90000;
  const oldData = [
    `auth_date=${oldDate}`,
    `user=${userStr}`,
  ];
  oldData.sort((a, b) => a.localeCompare(b));
  const oldHash = crypto.createHmac('sha256', secretKey).update(oldData.join('\n')).digest('hex');
  const expiredInitData = `auth_date=${oldDate}&user=${encodeURIComponent(userStr)}&hash=${oldHash}`;
  const expiredResult = validateTelegramInitData(expiredInitData, [mockBotToken]);
  assert.strictEqual(expiredResult.valid, false);
  assert.match(expiredResult.error || '', /expired/i);
});
