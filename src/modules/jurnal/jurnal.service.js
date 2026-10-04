// src/modules/jurnal/jurnal.service.js
//
// Service jurnal = satu pintu (docs/RancanganSistem.md, Alur 4 di ERD).
// Semua modul (manual, PR Track, pinjaman, kontraktor, penjualan, mirror)
// membuat jurnal lewat buatJurnal(), di dalam transaksi pemanggil. Satu cek
// gagal, tidak ada yang tersimpan.
import { db } from '../../config/database.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { nextNumber, pad } from '../../shared/utils/penomoran.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import * as repo from './jurnal.repository.js';

const PREFIX = { manual: 'JU', pr_track: 'JT', pinjaman: 'JP', kontraktor: 'JK', penjualan: 'JJ', mirror: 'JM' };
const PREFIX_BALIK = 'JB';

const today = () => new Date().toISOString().slice(0, 10);

// ── DTO ─────────────────────────────────────────────────────

const tipeLampiran = (mime) => (mime === 'application/pdf' ? 'pdf' : 'gambar');

export const toLampiranDto = (l) => ({
  id: l.id,
  nama: l.namaFile,
  tipe: tipeLampiran(l.mime),
  mime: l.mime,
  ukuranBytes: l.ukuran,
  url: `/api/v1/lampiran/${l.id}/unduh`,
  createdAt: l.createdAt,
});

/** Bentuk mengikuti Jurnal di frontend (src/store/jurnalStore.ts). */
export const toJurnalDto = (j, rows = [], files = []) => {
  const detail = rows.map((r) => ({
    id: r.id,
    akunId: r.akunId,
    kodePembantuId: r.kodePembantuId,
    keterangan: r.keterangan ?? '',
    debit: toNumber(r.debit),
    kredit: toNumber(r.kredit),
  }));
  const totalDebit = rows.reduce((s, r) => s + toCents(r.debit), 0n);
  const totalKredit = rows.reduce((s, r) => s + toCents(r.kredit), 0n);
  return {
    id: j.id,
    nomorJurnal: j.noBukti,
    tanggal: j.tanggal,
    keterangan: j.uraian,
    proyekId: j.proyekId,
    ptId: j.ptId,
    sumber: j.sumber,
    status: j.status,
    refType: j.refType,
    refId: j.refId,
    mirrorId: j.mirrorId,
    dibalikOlehId: j.dibalikOlehId,
    totalDebit: Number(centsToString(totalDebit)),
    totalKredit: Number(centsToString(totalKredit)),
    rows: detail,
    lampiran: files.map(toLampiranDto),
    dibuatOleh: j.dibuatOleh,
    dipostingPada: j.dipostingPada,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
};

async function hydrate(headers, tx = db) {
  const { rowsByJurnal, lampiranByJurnal } = await repo.loadChildren(headers.map((h) => h.id), tx);
  return headers.map((h) => toJurnalDto(h, rowsByJurnal.get(h.id), lampiranByJurnal.get(h.id)));
}

// ── Validasi ────────────────────────────────────────────────

const normalizeRows = (rows) =>
  rows.map((r) => ({
    akunId: r.akunId,
    kodePembantuId: r.kodePembantuId || null,
    keterangan: r.keterangan?.trim() || null,
    debit: centsToString(toCents(r.debit ?? 0)),
    kredit: centsToString(toCents(r.kredit ?? 0)),
  }));

/** Cek yang berlaku untuk draft maupun posting: akun dan kode pembantu harus ada. */
async function checkReferences(tx, rows, errors) {
  const akunIds = [...new Set(rows.map((r) => r.akunId))];
  const kpIds = [...new Set(rows.map((r) => r.kodePembantuId).filter(Boolean))];
  const [akuns, kps] = await Promise.all([repo.findAkunByIds(akunIds, tx), repo.findKodePembantuByIds(kpIds, tx)]);
  const akunMap = new Map(akuns.map((a) => [a.id, a]));
  const kpMap = new Map(kps.map((k) => [k.id, k]));

  rows.forEach((r, i) => {
    if (!akunMap.has(r.akunId)) errors.push(`Baris ${i + 1}: akun tidak ditemukan.`);
    if (r.kodePembantuId && !kpMap.has(r.kodePembantuId)) errors.push(`Baris ${i + 1}: kode pembantu tidak ditemukan.`);
  });
  return { akunMap, kpMap };
}

/**
 * Cek posting (Alur 4): seimbang, akun detail dan aktif, kode pembantu dan
 * proyek bila wajib, periode terbuka, lampiran bila ada akun kas/bank.
 */
async function checkPosting(tx, { header, rows, akunMap, kpMap, lampiranCount }, errors) {
  if (rows.length < 2) errors.push('Jurnal minimal terdiri dari 2 baris.');

  let debit = 0n;
  let kredit = 0n;
  let adaKasBank = false;

  rows.forEach((r, i) => {
    const d = toCents(r.debit);
    const k = toCents(r.kredit);
    debit += d;
    kredit += k;
    if ((d > 0n) === (k > 0n)) errors.push(`Baris ${i + 1}: isi debit atau kredit, salah satu saja.`);

    const a = akunMap.get(r.akunId);
    if (!a) return;
    if (!a.aktif) errors.push(`Baris ${i + 1}: akun ${a.kode} nonaktif.`);
    if (a.punyaAnak) errors.push(`Baris ${i + 1}: akun ${a.kode} adalah akun induk, pilih akun detail.`);
    if (a.wajibKodePembantu && !r.kodePembantuId) errors.push(`Baris ${i + 1}: akun ${a.kode} wajib kode pembantu.`);
    if (a.wajibProyek && !header.proyekId) errors.push(`Baris ${i + 1}: akun ${a.kode} wajib proyek.`);
    if (a.isKasBank) adaKasBank = true;
    const kp = r.kodePembantuId && kpMap.get(r.kodePembantuId);
    if (kp && !kp.aktif) errors.push(`Baris ${i + 1}: kode pembantu ${kp.nama} nonaktif.`);
  });

  if (debit === 0n) errors.push('Total debit tidak boleh nol.');
  else if (debit !== kredit) errors.push('Total debit harus sama dengan total kredit.');

  if (header.ptId && (await repo.isPeriodeTerkunci(header.ptId, header.tanggal, tx))) {
    errors.push(`Periode ${header.tanggal.slice(0, 7)} sudah dikunci. Gunakan jurnal balik di periode berjalan.`);
  }

  if (adaKasBank && lampiranCount === 0) {
    errors.push('Akun kas/bank terlibat. Unggah lampiran bukti sebelum posting.');
  }
}

async function resolveHeader(tx, input, errors) {
  let ptId = null;
  if (input.proyekId) {
    const proyek = await repo.findProyek(input.proyekId, tx);
    if (!proyek || proyek.isDeleted) {
      errors.push('Proyek tidak ditemukan.');
    } else {
      ptId = await repo.findPtByProyek(input.proyekId, tx);
      const saldoAwal = await repo.findSaldoAwalPeriode(input.proyekId, tx);
      if (saldoAwal && input.tanggal < saldoAwal.tanggalMulai) {
        errors.push(`Tanggal jurnal sebelum tanggal mulai saldo awal proyek (${saldoAwal.tanggalMulai}).`);
      }
    }
  }
  return { tanggal: input.tanggal, proyekId: input.proyekId ?? null, ptId };
}

const fail = (errors) => {
  throw new AppError(errors.length === 1 ? errors[0] : 'Jurnal tidak dapat disimpan.', 422, errors);
};

async function nomorBukti(tx, prefix, tanggal) {
  const [tahun, bulan] = tanggal.split('-').map(Number);
  const n = await nextNumber(tx, { jenis: `jurnal_${prefix}`, tahun, bulan });
  return `${prefix}-${tahun}${String(bulan).padStart(2, '0')}-${pad(n)}`;
}

// ── Gerbang jurnal untuk semua modul ────────────────────────

/**
 * Membuat jurnal di dalam transaksi `tx`.
 *
 * input: { tanggal, uraian, proyekId?, status: 'draft'|'diposting', sumber,
 *          refType?, refId?, mirrorId?, rows: [{ akunId, kodePembantuId?, keterangan?, debit, kredit }] }
 * opts.lampiranCount: jumlah lampiran bukti milik dokumen asal (modul otomatis
 *          yang menyimpan buktinya di entitasnya sendiri). Jurnal baru belum
 *          punya lampiran sendiri, jadi posting langsung dari layar manual
 *          dengan akun kas/bank akan ditolak.
 */
export async function buatJurnal(tx, actor, input, opts = {}) {
  const errors = [];
  const rows = normalizeRows(input.rows ?? []);
  if (!rows.length) errors.push('Jurnal minimal terdiri dari 1 baris.');

  const header = await resolveHeader(tx, input, errors);
  const { akunMap, kpMap } = await checkReferences(tx, rows, errors);

  const posting = input.status === 'diposting';
  if (posting && !errors.length) {
    await checkPosting(tx, { header, rows, akunMap, kpMap, lampiranCount: opts.lampiranCount ?? 0 }, errors);
  }
  if (errors.length) fail(errors);

  const now = new Date();
  const created = await repo.insertJurnal(tx, {
    noBukti: await nomorBukti(tx, opts.prefix ?? PREFIX[input.sumber] ?? 'JU', header.tanggal),
    tanggal: header.tanggal,
    uraian: input.uraian.trim(),
    proyekId: header.proyekId,
    ptId: header.ptId,
    status: input.status,
    sumber: input.sumber,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    mirrorId: input.mirrorId ?? null,
    dibuatOleh: actor.userId ?? null,
    dipostingOleh: posting ? actor.userId ?? null : null,
    dipostingPada: posting ? now : null,
  }, rows);

  await recordAuditTx(tx, {
    userId: actor.userId, ip: actor.ip, action: posting ? AuditAction.POST : AuditAction.CREATE,
    entity: 'jurnal', entityId: created.id, summary: `${created.noBukti} ${created.uraian}`,
  });
  return created;
}

// ── Layar jurnal umum (sumber manual) ───────────────────────

export async function list(query) {
  const { total, headers } = await repo.listJurnal(query);
  return { items: await hydrate(headers), meta: { page: query.page, limit: query.limit, total } };
}

export async function get(id) {
  const j = await repo.findJurnal(id);
  if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
  const [dto] = await hydrate([j]);
  return dto;
}

export async function createManual(actor, body) {
  const created = await db.transaction((tx) => buatJurnal(tx, actor, { ...body, sumber: 'manual' }));
  return get(created.id);
}

const assertManual = (j) => {
  if (j.sumber !== 'manual') {
    throw new AppError('Jurnal otomatis hanya bisa dikoreksi dari modul asalnya.', 409);
  }
};

const snapshot = async (tx, j) => {
  const { rowsByJurnal } = await repo.loadChildren([j.id], tx);
  return { header: j, rows: rowsByJurnal.get(j.id) ?? [] };
};

/**
 * Ubah jurnal manual (Alur 5): draft bebas; yang sudah diposting boleh
 * diubah selama periodenya terbuka, nilai lama dicatat di audit_log.
 */
export async function updateManual(actor, id, body) {
  await db.transaction(async (tx) => {
    const j = await repo.lockJurnal(tx, id);
    if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
    assertManual(j);
    if (!['draft', 'diposting'].includes(j.status)) {
      throw new AppError('Jurnal yang sudah dikoreksi tidak bisa diubah.', 409);
    }

    const errors = [];
    const rows = normalizeRows(body.rows);
    const header = await resolveHeader(tx, body, errors);
    const { akunMap, kpMap } = await checkReferences(tx, rows, errors);

    // Jurnal yang sudah diposting tetap berstatus diposting setelah diubah
    const posting = j.status === 'diposting' || body.status === 'diposting';
    if (j.status === 'diposting' && j.ptId && (await repo.isPeriodeTerkunci(j.ptId, j.tanggal, tx))) {
      errors.push('Periode jurnal asal sudah dikunci. Gunakan jurnal balik.');
    }
    if (posting && !errors.length) {
      const lampiranCount = await repo.countLampiran(id, tx);
      await checkPosting(tx, { header, rows, akunMap, kpMap, lampiranCount }, errors);
    }
    if (errors.length) fail(errors);

    const before = j.status === 'diposting' ? await snapshot(tx, j) : null;
    const baruDiposting = posting && j.status === 'draft';
    await repo.updateJurnal(tx, id, {
      tanggal: header.tanggal,
      uraian: body.uraian.trim(),
      proyekId: header.proyekId,
      ptId: header.ptId,
      status: posting ? 'diposting' : 'draft',
      ...(baruDiposting ? { dipostingOleh: actor.userId, dipostingPada: new Date() } : {}),
    });
    await repo.replaceRows(tx, id, rows);

    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip,
      action: baruDiposting ? AuditAction.POST : AuditAction.UPDATE,
      entity: 'jurnal', entityId: id, summary: `${j.noBukti} diubah`,
      metadata: before ? { sebelum: before } : {},
    });
  });
  return get(id);
}

export async function postDraft(actor, id) {
  await db.transaction(async (tx) => {
    const j = await repo.lockJurnal(tx, id);
    if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
    if (j.status !== 'draft') throw new AppError('Hanya jurnal draft yang bisa diposting.', 409);

    const { rowsByJurnal } = await repo.loadChildren([id], tx);
    const rows = rowsByJurnal.get(id) ?? [];
    const errors = [];
    // PT bisa baru terhubung ke proyek setelah draft dibuat, jadi diresolusi ulang
    const header = await resolveHeader(tx, { tanggal: j.tanggal, proyekId: j.proyekId }, errors);
    const { akunMap, kpMap } = await checkReferences(tx, rows, errors);
    const lampiranCount = await repo.countLampiran(id, tx);
    if (!errors.length) await checkPosting(tx, { header, rows, akunMap, kpMap, lampiranCount }, errors);
    if (errors.length) fail(errors);

    await repo.updateJurnal(tx, id, {
      status: 'diposting', ptId: header.ptId, dipostingOleh: actor.userId, dipostingPada: new Date(),
    });
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.POST, entity: 'jurnal', entityId: id, summary: j.noBukti,
    });
  });
  return get(id);
}

export async function removeManual(actor, id) {
  await db.transaction(async (tx) => {
    const j = await repo.lockJurnal(tx, id);
    if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
    assertManual(j);
    if (j.status === 'diposting') {
      if (j.ptId && (await repo.isPeriodeTerkunci(j.ptId, j.tanggal, tx))) {
        throw new AppError('Periode sudah dikunci. Gunakan jurnal balik.', 409);
      }
    } else if (j.status !== 'draft') {
      throw new AppError('Jurnal yang sudah dikoreksi tidak bisa dihapus.', 409);
    }
    if (await repo.countLampiran(id, tx)) {
      throw new AppError('Hapus lampiran jurnal terlebih dahulu.', 409);
    }

    const before = await snapshot(tx, j);
    await repo.deleteJurnal(tx, id);
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.DELETE, entity: 'jurnal', entityId: id,
      summary: `${j.noBukti} dihapus`, metadata: { sebelum: before },
    });
  });
}

/**
 * Jurnal balik (Alur 5, periode terkunci): membuat jurnal kebalikan bertanggal
 * periode berjalan. Jurnal asal menjadi Dikoreksi dan menunjuk jurnal baliknya.
 * Jurnal yang benar dibuat terpisah oleh pengguna.
 */
export async function balik(actor, id, { tanggal = today(), uraian } = {}) {
  const reversal = await db.transaction(async (tx) => {
    const j = await repo.lockJurnal(tx, id);
    if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
    if (j.status !== 'diposting') throw new AppError('Hanya jurnal yang sudah diposting yang bisa dibalik.', 409);
    if (j.sumber !== 'manual' && j.sumber !== 'pr_track') {
      throw new AppError('Jurnal otomatis hanya bisa dikoreksi dari modul asalnya.', 409);
    }

    const { rowsByJurnal } = await repo.loadChildren([id], tx);
    const rows = (rowsByJurnal.get(id) ?? []).map((r) => ({
      akunId: r.akunId, kodePembantuId: r.kodePembantuId, keterangan: r.keterangan, debit: r.kredit, kredit: r.debit,
    }));

    const errors = [];
    const header = await resolveHeader(tx, { tanggal, proyekId: j.proyekId }, errors);
    if (header.ptId && (await repo.isPeriodeTerkunci(header.ptId, tanggal, tx))) {
      errors.push(`Periode ${tanggal.slice(0, 7)} sudah dikunci.`);
    }
    if (errors.length) fail(errors);

    // Akun boleh sudah nonaktif sejak jurnal asal dibuat; pembalik tetap harus bisa dibuat
    const created = await repo.insertJurnal(tx, {
      noBukti: await nomorBukti(tx, PREFIX_BALIK, tanggal),
      tanggal,
      uraian: uraian?.trim() || `Pembalik ${j.noBukti}: ${j.uraian}`,
      proyekId: j.proyekId,
      ptId: header.ptId,
      status: 'balik',
      sumber: j.sumber,
      refType: 'jurnal',
      refId: j.id,
      dibuatOleh: actor.userId,
      dipostingOleh: actor.userId,
      dipostingPada: new Date(),
    }, normalizeRows(rows));

    await repo.updateJurnal(tx, id, { status: 'dikoreksi', dibalikOlehId: created.id });
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.REVERSE, entity: 'jurnal', entityId: id,
      summary: `${j.noBukti} dibalik oleh ${created.noBukti}`,
    });
    return created;
  });
  return get(reversal.id);
}
