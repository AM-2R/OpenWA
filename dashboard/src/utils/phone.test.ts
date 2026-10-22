import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneText } from './phone.ts';

const char = (code: number) => String.fromCharCode(code);
const digitsOf = (zero: number) => [...'0123456789'].map(d => char(zero + Number(d))).join('');

test('the digits of any script read as ASCII digits', () => {
  for (const zero of [0x0660, 0x06f0, 0x0966, 0x0c66, 0xff10]) {
    assert.equal(normalizePhoneText(digitsOf(zero)), '0123456789');
  }
  assert.equal(normalizePhoneText(`+${digitsOf(0x0660).slice(0, 2)} 6281`), '+01 6281');
});

test('the full-width forms of ASCII characters read as ASCII', () => {
  assert.equal(normalizePhoneText(`${char(0xff0b)}65 8123 4567`), '+65 8123 4567');
  assert.equal(normalizePhoneText(`6281${char(0xff0c)}6282`), '6281,6282');
});

test('invisible format marks are dropped', () => {
  assert.equal(normalizePhoneText(`${char(0x202a)}+65 8123${char(0x202c)}`), '+65 8123');
});

test('circled, superscript and fraction characters are left alone', () => {
  const marks = `${char(0x2460)}${char(0x00b9)}${char(0x00bc)}`;
  assert.equal(normalizePhoneText(`${marks}628`), `${marks}628`);
});

test('ASCII text, letters and punctuation come back unchanged', () => {
  assert.equal(normalizePhoneText('+62 (812) 345-6789, abc\n'), '+62 (812) 345-6789, abc\n');
  assert.equal(normalizePhoneText(''), '');
});

// Nearly every number is plain ASCII, so it must cost no per-character work: mapping every digit made a 2 MiB
// recipient list about ten times slower to parse, and the recipient list is parsed while typing.
test('ASCII text is returned without any per-character mapping', t => {
  let calls = 0;
  const original = String.prototype.codePointAt;
  t.mock.method(String.prototype, 'codePointAt', function (this: string, index: number) {
    calls++;
    return original.call(this, index);
  });
  const text = '6281234567890\n+62 (812) 345-6789, abc\n'.repeat(50);
  assert.equal(normalizePhoneText(text), text);
  assert.equal(calls, 0);
  // Control: a native-script digit does go through the mapper.
  assert.equal(normalizePhoneText(char(0x0662)), '2');
  assert.ok(calls > 0);
});
