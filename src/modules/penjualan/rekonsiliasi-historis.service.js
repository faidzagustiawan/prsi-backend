// src/modules/penjualan/rekonsiliasi-historis.service.js
//
// Laporan cutoff Opsi A (docs/deploy/opsi-cutoff-pembayaran-lama.md): pembayaran
// PR Track berstatus "historis" (tidak dijurnal) dibandingkan dengan saldo awal
// customer di proyek yang sama. Pembayaran historis dianggap sudah terwakili saldo
// awal titipan booking fee / uang muka penjualan pada kode pembantu customer.
//
// Status per customer:
//   cocok        saldo awal diterima = total historis, tanpa saldo awal piutang
//   cek_piutang    ada saldo awal piutang (biasanya sesudah BAST): pembayaran
//                  mengurangi piutang, jadi tidak bisa dibandingkan otomatis
//   perlu_ditinjau ada pembayaran lama yang tidak otomatis menjadi historis
//                  (input mundur, refund, berubah sesudah cutoff)
//   selisih        saldo awal diterima != total historis
import { sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString } from '../../shared/utils/money.js';
import { env } from '../../config/env.js';

const AKUN_DITERIMA = ['titipan_booking_fee', 'uang_muka_penjualan'];
const AKUN_PIUTANG = ['piutang_penjualan'];
const num = (cents) => Number(centsToString(cents));

export async function rekonsiliasiHistoris(proyekId) {
  const [periode] = await db.execute(sql`
    SELECT id, tanggal_mulai::text AS tanggal_mulai, status FROM finance.saldo_awal_periode WHERE proyek_id = ${proyekId}`);
  if (!periode) throw new AppError('Saldo awal proyek belum dibuat; rekonsiliasi historis memerlukan tanggal mulai saldo awal.', 404);

  // Satu akun bisa dipetakan ke lebih dari satu peran; pakai himpunan akun agar tidak terhitung ganda.
  const peran = await db.execute(sql`SELECT kunci, akun_id FROM finance.akun_sistem
    WHERE kunci IN (${sql.join([...AKUN_DITERIMA, ...AKUN_PIUTANG].map((k) => sql`${k}`), sql`, `)})`);
  const akunDiterima = [...new Set(peran.filter((r) => AKUN_DITERIMA.includes(r.kunci)).map((r) => r.akun_id))];
  const akunPiutang = [...new Set(peran.filter((r) => AKUN_PIUTANG.includes(r.kunci)).map((r) => r.akun_id))];
  const inList = (ids) => (ids.length ? sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `) : sql`NULL::uuid`);

  const historis = await db.execute(sql`
    SELECT a.customer_id, p.jenis, count(*)::int AS n, sum(p.nominal)::text AS total
    FROM finance.trk_payments p
    JOIN finance.status_pembayaran_si s ON s.payment_id = p.id
    JOIN finance.trk_assignments a ON a.id = p.assignment_id
    JOIN finance.trk_units u ON u.id = a.unit_id
    WHERE s.status_proses = 'historis' AND u.project_id = ${proyekId}
    GROUP BY a.customer_id, p.jenis`);

  // Pembayaran lama yang tidak otomatis menjadi historis dan perlu keputusan Keuangan.
  const ditinjau = await db.execute(sql`
    SELECT a.customer_id, count(*)::int AS n, sum(p.nominal)::text AS total
    FROM finance.trk_payments p
    JOIN finance.status_pembayaran_si s ON s.payment_id = p.id
    JOIN finance.trk_assignments a ON a.id = p.assignment_id
    JOIN finance.trk_units u ON u.id = a.unit_id
    WHERE s.status_proses = 'perlu_ditinjau' AND p.si_jadwal_id IS NULL
      AND p.tanggal < ${periode.tanggal_mulai} AND u.project_id = ${proyekId}
    GROUP BY a.customer_id`);

  const saldo = await db.execute(sql`
    SELECT kp.customer_id,
      sum(CASE WHEN sa.akun_id IN (${inList(akunDiterima)}) THEN sa.kredit - sa.debit ELSE 0 END)::text AS diterima,
      sum(CASE WHEN sa.akun_id IN (${inList(akunPiutang)}) THEN sa.debit - sa.kredit ELSE 0 END)::text AS piutang
    FROM finance.saldo_awal sa
    JOIN finance.kode_pembantu kp ON kp.id = sa.kode_pembantu_id AND kp.kategori = 'pembeli' AND kp.customer_id IS NOT NULL
    WHERE sa.periode_id = ${periode.id}
    GROUP BY kp.customer_id`);

  const ids = new Set([...historis, ...ditinjau, ...saldo].map((r) => r.customer_id));
  const nama = ids.size
    ? new Map((await db.execute(sql`SELECT id, nama FROM finance.trk_customers
        WHERE id IN (${sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `)})`)).map((c) => [c.id, c.nama]))
    : new Map();

  const baris = [...ids].map((customerId) => {
    const mine = historis.filter((h) => h.customer_id === customerId);
    const totalHistoris = mine.reduce((s, h) => s + toCents(h.total), 0n);
    const sa = saldo.find((r) => r.customer_id === customerId);
    const diterima = toCents(sa?.diterima ?? 0);
    const piutang = toCents(sa?.piutang ?? 0);
    const tinjau = ditinjau.find((r) => r.customer_id === customerId);
    const selisih = diterima - totalHistoris;
    return {
      customerId,
      namaCustomer: nama.get(customerId) ?? null,
      jumlahHistoris: mine.reduce((s, h) => s + h.n, 0),
      totalHistoris: num(totalHistoris),
      historisPerJenis: Object.fromEntries(mine.map((h) => [h.jenis ?? 'tanpa_jenis', num(toCents(h.total))])),
      saldoAwalDiterima: num(diterima),
      saldoAwalPiutang: num(piutang),
      selisih: num(selisih),
      perluDitinjau: tinjau ? { jumlah: tinjau.n, total: num(toCents(tinjau.total)) } : null,
      status: piutang !== 0n ? 'cek_piutang' : tinjau ? 'perlu_ditinjau' : selisih === 0n ? 'cocok' : 'selisih',
    };
  }).sort((a, b) => String(a.namaCustomer).localeCompare(String(b.namaCustomer)));

  const hitung = (status) => baris.filter((b) => b.status === status).length;
  // Keputusan pemilik 21 Oktober 2026: tanggal mulai saldo awal = tanggal cutover (WIB),
  // supaya semua pembayaran sebelum cutover menjadi historis.
  const tanggalCutover = env.legacyCutoverAt?.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) ?? null;
  return {
    proyekId,
    tanggalMulaiSaldoAwal: periode.tanggal_mulai,
    statusSaldoAwal: periode.status,
    cutoverAt: env.legacyCutoverAt?.toISOString() ?? null,
    tanggalCutover,
    tanggalMulaiSamaDenganCutover: tanggalCutover === periode.tanggal_mulai,
    akunSistemLengkap: akunDiterima.length > 0,
    ringkasan: {
      customer: baris.length, cocok: hitung('cocok'), selisih: hitung('selisih'), cekPiutang: hitung('cek_piutang'),
      customerPerluDitinjau: hitung('perlu_ditinjau'),
      totalHistoris: num(baris.reduce((s, b) => s + toCents(b.totalHistoris), 0n)),
      totalSaldoAwalDiterima: num(baris.reduce((s, b) => s + toCents(b.saldoAwalDiterima), 0n)),
      perluDitinjau: baris.reduce((s, b) => s + (b.perluDitinjau?.jumlah ?? 0), 0),
    },
    baris,
  };
}
