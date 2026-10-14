// Admin mail console: recipient parsing and the config gate (pure unit
// checks; no network, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipients, mailConfigured } from '../dist/core/admin/adminMail.js';

test('recipients: plain, named, multiple, dedupe, and invalid stay separate', () => {
  assert.deepEqual(parseRecipients('a@b.co').addresses, ['a@b.co']);
  assert.deepEqual(parseRecipients('QA <qa@example.com>').addresses, ['qa@example.com']);
  assert.deepEqual(parseRecipients('a@b.co, c@d.io; e@f.net').addresses, ['a@b.co', 'c@d.io', 'e@f.net']);
  assert.deepEqual(parseRecipients('a@b.co, a@b.co').addresses, ['a@b.co']);
  const mixed = parseRecipients('nope, yes@no, ok@fine.org');
  assert.deepEqual(mixed.addresses, ['ok@fine.org']);
  assert.deepEqual(mixed.invalid, ['nope', 'yes@no']);
});

test('recipients: header-injection shapes are rejected and the list caps at five', () => {
  const inj = parseRecipients('a@b.co\r\nBcc: evil@x.io');
  assert.deepEqual(inj.addresses, []);
  assert.equal(inj.invalid.length, 1);
  const six = parseRecipients('1@a.co, 2@a.co, 3@a.co, 4@a.co, 5@a.co, 6@a.co');
  assert.equal(six.addresses.length, 5);
});

test('mail config gate reads the MAIL_* environment', () => {
  delete process.env.MAIL_USER;
  delete process.env.MAIL_PASS;
  delete process.env.MAIL_IMAP_HOST;
  delete process.env.MAIL_SMTP_HOST;
  assert.equal(mailConfigured(), false);
  process.env.MAIL_IMAP_HOST = 'imap.example.com';
  process.env.MAIL_SMTP_HOST = 'smtp.example.com';
  process.env.MAIL_USER = 'u@example.com';
  process.env.MAIL_PASS = 'x';
  assert.equal(mailConfigured(), true);
  delete process.env.MAIL_IMAP_HOST;
  delete process.env.MAIL_SMTP_HOST;
  delete process.env.MAIL_USER;
  delete process.env.MAIL_PASS;
});
