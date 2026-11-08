import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableResumeError } from './resume-browser.js';
test('only connection interruptions permit automatic resume', () => {
  for (const message of ['The transfer connection was interrupted. Your saved progress can be resumed.', 'The transfer connection failed.', 'Could not reach CD. Check your connection.', 'Timed out waiting for peer']) assert.equal(isRetryableResumeError(new Error(message)), true);
  for (const message of ['This resumable CD transfer has expired.', 'Transfer canceled.', 'The received file failed its whole-file digest check.', 'Authentication failed.', 'Invalid checkpoint', '']) assert.equal(isRetryableResumeError(new Error(message)), false);
});

test('every application rejection is permanent, including authentication and policy codes', async () => {
  const { resumeCloseError } = await import('./resume-browser.js');
  for (let code = 4400; code <= 4499; code++) assert.equal(isRetryableResumeError(resumeCloseError(code)), false, String(code));
  for (const code of [1001, 1006, 1011, 1012, 1013]) assert.equal(isRetryableResumeError(resumeCloseError(code)), true, String(code));
  assert.equal(isRetryableResumeError(new Error('The transfer timed out waiting for the other device.')), true);
  assert.equal(isRetryableResumeError(new Error('The other device disconnected. Your saved progress can be resumed from the same private link.')), true);
});
