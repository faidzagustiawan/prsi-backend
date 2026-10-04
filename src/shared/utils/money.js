// src/shared/utils/money.js
//
// Nominal uang dihitung dalam sen (BigInt) supaya penjumlahan tidak terkena
// galat float. Database menyimpan NUMERIC(18,2); API menerima dan mengirim
// number rupiah dengan maksimal 2 angka desimal.

/** '1500.5' | 1500.5 -> 150050n */
export const toCents = (value) => {
  if (value === null || value === undefined || value === '') return 0n;
  const str = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!match) throw new Error(`Nominal tidak valid: ${value}`);
  const [, minus, whole, frac = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return minus ? -cents : cents;
};

/** 150050n -> '1500.50' (untuk disimpan ke NUMERIC) */
export const centsToString = (cents) => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = String(abs % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
};

/** NUMERIC dari database ('1500.50') -> 1500.5 untuk respons JSON */
export const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

export const sumCents = (values) => values.reduce((total, v) => total + toCents(v), 0n);
