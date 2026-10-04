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
    noReferensi: j.noReferensi,
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
 *          noReferensi?, refType?, refId?, mirrorId?, rows: [{ akunId, kodePembantuId?, keterangan?, debit, kredit }] }
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
    noReferensi: input.noReferensi ?? null,
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
      noReferensi: body.noReferensi ?? null,
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

// Modul pemilik jurnal bisa menolak posting dari layar jurnal, mis. transaksi
// pinjaman yang rincian pokok/bunganya belum diisi.
const postingGuards = new Map();
export const registerPostingGuard = (refType, fn) => postingGuards.set(refType, fn);

// Dipanggil di transaksi yang sama setelah draft diposting, mis. alokasi
// pembayaran PR Track ke jadwal angsuran.
const afterPosting = new Map();
export const registerAfterPosting = (refType, fn) => afterPosting.set(refType, fn);
const afterReverse = new Map();
export const registerAfterReverse = (refType, fn) => afterReverse.set(refType, fn);

async function checkDraft(tx, j, errors) {
  const { rowsByJurnal } = await repo.loadChildren([j.id], tx);
  const rows = rowsByJurnal.get(j.id) ?? [];
  // PT bisa baru terhubung ke proyek setelah draft dibuat, jadi diresolusi ulang
  const header = await resolveHeader(tx, { tanggal: j.tanggal, proyekId: j.proyekId }, errors);
  const { akunMap, kpMap } = await checkReferences(tx, rows, errors);
  const guard = j.refType && postingGuards.get(j.refType);
  if (guard) await guard(tx, j, errors);
  return { header, rows, akunMap, kpMap };
}

/**
 * Posting draft di dalam transaksi. Jurnal antar proyek (mirror) diposting
 * berpasangan; lampiran bukti boleh ada di salah satu sisi.
 */
export async function postingTx(tx, actor, id) {
  const j = await repo.lockJurnal(tx, id);
  if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
  if (j.status !== 'draft') throw new AppError('Hanya jurnal draft yang bisa diposting.', 409);
  const pair = j.mirrorId ? await repo.lockJurnal(tx, j.mirrorId) : null;
  const group = pair && pair.status === 'draft' ? [j, pair] : [j];

  const errors = [];
  const checked = [];
  for (const item of group) checked.push({ item, ...(await checkDraft(tx, item, errors)) });
  let lampiranCount = 0;
  for (const item of group) lampiranCount += await repo.countLampiran(item.id, tx);
  if (!errors.length) {
    for (const c of checked) await checkPosting(tx, { ...c, lampiranCount }, errors);
  }
  if (errors.length) fail(errors);

  for (const c of checked) {
    await repo.updateJurnal(tx, c.item.id, {
      status: 'diposting', ptId: c.header.ptId, dipostingOleh: actor.userId, dipostingPada: new Date(),
    });
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.POST, entity: 'jurnal', entityId: c.item.id, summary: c.item.noBukti,
    });
    const hook = c.item.refType && afterPosting.get(c.item.refType);
    if (hook) await hook(tx, actor, c.item);
  }
}

export async function postDraft(actor, id) {
  await db.transaction((tx) => postingTx(tx, actor, id));
  return get(id);
}

/** Modul mengganti isi draft miliknya (mis. rincian pokok/bunga baru diisi). */
export async function gantiDraftTx(tx, actor, id, { tanggal, uraian, rows }) {
  const j = await repo.lockJurnal(tx, id);
  if (!j || j.status !== 'draft') throw new AppError('Jurnal draft tidak ditemukan.', 409);
  const errors = [];
  const normalized = normalizeRows(rows);
  const header = await resolveHeader(tx, { tanggal: tanggal ?? j.tanggal, proyekId: j.proyekId }, errors);
  await checkReferences(tx, normalized, errors);
  if (errors.length) fail(errors);
  await repo.updateJurnal(tx, id, { tanggal: header.tanggal, ptId: header.ptId, ...(uraian ? { uraian } : {}) });
  await repo.replaceRows(tx, id, normalized);
  await recordAuditTx(tx, {
    userId: actor.userId, ip: actor.ip, action: AuditAction.UPDATE, entity: 'jurnal', entityId: id, summary: `${j.noBukti} diubah modul`,
  });
}

/**
 * Modul menghapus jurnalnya: draft, atau diposting selama periode terbuka.
 * Pasangan mirror ikut dihapus. Mengembalikan false bila jurnal tidak ada.
 */
export async function hapusJurnalModulTx(tx, actor, id) {
  const j = await repo.lockJurnal(tx, id);
  if (!j) return false;
  const group = [j];
  if (j.mirrorId) {
    const pair = await repo.lockJurnal(tx, j.mirrorId);
    if (pair) group.push(pair);
  }
  for (const item of group) {
    if (!['draft', 'diposting'].includes(item.status)) {
      throw new AppError(`Jurnal ${item.noBukti} sudah dikoreksi, tidak bisa dihapus.`, 409);
    }
    if (item.status === 'diposting' && item.ptId && (await repo.isPeriodeTerkunci(item.ptId, item.tanggal, tx))) {
      throw new AppError(`Periode jurnal ${item.noBukti} sudah dikunci.`, 409);
    }
    if (await repo.countLampiran(item.id, tx)) {
      throw new AppError(`Hapus lampiran jurnal ${item.noBukti} terlebih dahulu.`, 409);
    }
  }
  // Putus tautan mirror dulu supaya FK tidak menghalangi
  for (const item of group) if (item.mirrorId) await repo.updateJurnal(tx, item.id, { mirrorId: null });
  for (const item of group) {
    const before = await snapshot(tx, item);
    await repo.deleteJurnal(tx, item.id);
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.DELETE, entity: 'jurnal', entityId: item.id,
      summary: `${item.noBukti} dihapus`, metadata: { sebelum: before },
    });
  }
  return true;
}

export async function setMirrorTx(tx, aId, bId) {
  await repo.updateJurnal(tx, aId, { mirrorId: bId });
  await repo.updateJurnal(tx, bId, { mirrorId: aId });
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
    const hook = j.refType && afterReverse.get(j.refType);
    if (hook) await hook(tx, actor, j);
    await recordAuditTx(tx, {
      userId: actor.userId, ip: actor.ip, action: AuditAction.REVERSE, entity: 'jurnal', entityId: id,
      summary: `${j.noBukti} dibalik oleh ${created.noBukti}`,
    });
    return created;
  });
  return get(reversal.id);
}

/**
 * Jurnal otomatis dari modul: langsung diposting bila tidak menyentuh akun
 * kas/bank. Bila menyentuh kas/bank, disimpan sebagai draft sampai bukti
 * diunggah ke jurnalnya lalu diposting (POST /jurnal/:id/posting).
 */
export async function buatJurnalOtomatis(tx, actor, input) {
  const akunIds = [...new Set(input.rows.map((r) => r.akunId))];
  const akuns = await repo.findAkunByIds(akunIds, tx);
  const adaKasBank = akuns.some((a) => a.isKasBank);
  return buatJurnal(tx, actor, { ...input, status: adaKasBank ? 'draft' : 'diposting' });
}

/** Status ringkas jurnal milik dokumen modul: { id, nomorJurnal, status, jumlahLampiran }. */
export async function ringkasJurnal(ids, tx = db) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  const headers = await repo.findJurnalByIds(unique, tx);
  const { lampiranByJurnal } = await repo.loadChildren(unique, tx);
  for (const h of headers) {
    map.set(h.id, {
      id: h.id, nomorJurnal: h.noBukti, status: h.status, jumlahLampiran: lampiranByJurnal.get(h.id)?.length ?? 0,
    });
  }
  return map;
}
