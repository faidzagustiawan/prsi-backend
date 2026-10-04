// src/modules/legal/dokumen.service.js
//
// Dokumen SPPR (FE: dokumenLegalStore). Selama draft semua isi bisa diubah.
// Finalisasi (Alur 3, "SPPR final") dalam satu transaksi:
//   1. penjualan_keuangan dibuat untuk penjualan Track (assignmentId)
//   2. jadwal DP dipindah ke jadwal_angsuran + antre dikirim ke Track
//   3. jurnal: D Titipan booking fee  K Uang muka penjualan (booking fee yang sudah masuk)
// Setelah final, angka dan jadwal terkunci; perubahan lewat adendum.
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../config/database.js';
import { dokumen, dokumenPasal, templateDokumen, templatePasal, pasal, penjualanKeuangan, jadwalAngsuran, outboxTrack } from '../../shared/schemas/penjualan.schema.js';
import { masterPt, lampiran } from '../../shared/schemas/akuntansi.schema.js';
import { trkUnits } from '../../shared/schemas/track.schema.js';
import { auditLogs, users } from '../../shared/schemas/finance.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { toCents, centsToString, toNumber } from '../../shared/utils/money.js';
import { nextNumber, pad } from '../../shared/utils/penomoran.js';
import { recordAuditTx, AuditAction } from '../../shared/utils/audit.js';
import { TIPE_TRANSAKSI_LABEL, TIPE_DARI_TRACK } from '../../shared/constants.js';
import { buatJurnal, toLampiranDto } from '../jurnal/jurnal.service.js';
import { akunPeran } from '../akun-sistem/akun-sistem.routes.js';
import { findAssignment, kodePembantuPembeli, saldoAkunKp, hitungJadwal } from '../penjualan/penjualan.helpers.js';

const STATUS_FIELD = 'status';

// ── DTO ─────────────────────────────────────────────────────

const PEMBELI_KOSONG = { nama: '', ttl: '', pekerjaan: '', alamat: '', noKtp: '', noHp: '' };

function toDto(d, { unit, pasals = [], riwayat = [], files = [] }) {
  const data = d.data ?? {};
  const hargaNett = Number(centsToString(toCents(data.hargaAwal ?? 0) + toCents(data.bphtb ?? 0) + toCents(data.ajbBbn ?? 0)));
  return {
    id: d.id,
    noDokumen: d.noDokumen,
    ptId: d.ptId,
    // FE: kavlingId / perumahanId
    kavlingId: d.unitId,
    kavling: unit ? { id: unit.id, kode: unit.kode, tipe: unit.tipe, luasTanah: toNumber(unit.luasTanah), luasBangunan: toNumber(unit.luasBangunan) } : null,
    perumahanId: unit?.projectId ?? null,
    assignmentId: d.assignmentId,
    templateId: d.templateId,
    pembeli: { ...PEMBELI_KOSONG, ...(data.pembeli ?? {}) },
    tipeTransaksi: TIPE_TRANSAKSI_LABEL[d.tipeTransaksi],
    hargaAwal: data.hargaAwal ?? 0,
    bphtb: data.bphtb ?? 0,
    ajbBbn: data.ajbBbn ?? 0,
    uangMuka: data.uangMuka ?? 0,
    hargaNett,
    tanggalPerjanjian: d.tanggal,
    status: d.status,
    pasalDokumen: pasals.map((p) => ({ id: p.id, pustakaId: p.pustakaId ?? undefined, judul: p.judul, isi: p.teks, fields: p.nilaiField })),
    jadwalPembayaran: d.jadwal ?? undefined,
    fasilitasTambahan: data.fasilitasTambahan ?? undefined,
    lampiran: files.map(toLampiranDto),
    riwayatStatus: riwayat,
    indukId: d.indukId,
    createdAt: d.createdAt,
  };
}

async function hydrate(rows, tx = db) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const unitIds = [...new Set(rows.map((r) => r.unitId))];
  const [units, pasals, logs, files] = await Promise.all([
    tx.select().from(trkUnits).where(inArray(trkUnits.id, unitIds)),
    tx.select().from(dokumenPasal).where(inArray(dokumenPasal.dokumenId, ids)).orderBy(asc(dokumenPasal.urutan)),
    tx.select({ entityId: auditLogs.entityId, status: auditLogs.summary, waktu: auditLogs.createdAt, oleh: users.nama })
      .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.entity, 'dokumen'), eq(auditLogs.field, STATUS_FIELD), inArray(auditLogs.entityId, ids)))
      .orderBy(asc(auditLogs.createdAt)),
    tx.select().from(lampiran).where(and(eq(lampiran.entityType, 'dokumen'), inArray(lampiran.entityId, ids))),
  ]);
  const unitMap = new Map(units.map((u) => [u.id, u]));
  const by = (list, key) => list.reduce((m, x) => m.set(x[key], [...(m.get(x[key]) ?? []), x]), new Map());
  const pasalBy = by(pasals, 'dokumenId');
  const logBy = by(logs, 'entityId');
  const fileBy = by(files, 'entityId');
  return rows.map((d) => toDto(d, {
    unit: unitMap.get(d.unitId),
    pasals: pasalBy.get(d.id),
    riwayat: (logBy.get(d.id) ?? []).map((l) => ({ status: l.status, waktu: l.waktu, oleh: l.oleh ?? 'Sistem' })),
    files: fileBy.get(d.id),
  }));
}

export async function list({ perumahanId, status, q }) {
  const f = [];
  if (status) f.push(eq(dokumen.status, status));
  if (perumahanId) f.push(eq(trkUnits.projectId, perumahanId));
  if (q) f.push(or(ilike(dokumen.noDokumen, `%${q}%`), sql`${dokumen.data}->'pembeli'->>'nama' ILIKE ${`%${q}%`}`));
  const rows = await db.select({ d: dokumen }).from(dokumen).innerJoin(trkUnits, eq(trkUnits.id, dokumen.unitId))
    .where(f.length ? and(...f) : undefined).orderBy(desc(dokumen.createdAt));
  return hydrate(rows.map((r) => r.d));
}

export async function get(id, tx = db) {
  const [d] = await tx.select().from(dokumen).where(eq(dokumen.id, id)).limit(1);
  if (!d) throw new AppError('Dokumen tidak ditemukan.', 404);
  const [dto] = await hydrate([d], tx);
  return dto;
}

// ── Pembuatan dan ubah ──────────────────────────────────────

const logStatus = (tx, actor, id, status) => recordAuditTx(tx, {
  ...actor, action: AuditAction.UPDATE, entity: 'dokumen', entityId: id, field: STATUS_FIELD, summary: status, metadata: { status },
});

async function nomorDokumen(tx, { pt, template, tipe, tanggal }) {
  const [tahun, bulan] = tanggal.split('-');
  const singkatan = pt.singkatan || pt.namaPt.split(/\s+/).filter((w) => w !== 'PT').map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  const pola = template?.polaNomor ?? '{PT}/{TAHUN}/{TIPE}/{NO}';
  const n = await nextNumber(tx, { jenis: 'dokumen', scope: `${pt.id}:${tipe}`, tahun: Number(tahun) });
  return pola.replace('{PT}', singkatan).replace('{TAHUN}', tahun).replace('{BULAN}', bulan)
    .replace('{TIPE}', TIPE_TRANSAKSI_LABEL[tipe].toUpperCase().replace(' ', '_')).replace('{NO}', pad(n));
}

async function pilihTemplate(tx, { templateId, ptId, tipe }) {
  if (templateId) {
    const [t] = await tx.select().from(templateDokumen).where(eq(templateDokumen.id, templateId)).limit(1);
    if (!t) throw new AppError('Template tidak ditemukan.', 422);
    if (t.ptId !== ptId || t.tipeTransaksi !== tipe) throw new AppError('Template tidak cocok dengan PT dan tipe transaksi.', 422);
    return t;
  }
  const [t] = await tx.select().from(templateDokumen)
    .where(and(eq(templateDokumen.ptId, ptId), eq(templateDokumen.tipeTransaksi, tipe), eq(templateDokumen.aktif, true)))
    .orderBy(asc(templateDokumen.createdAt)).limit(1);
  return t ?? null;
}

const toData = (b, base = {}) => {
  const data = { ...base };
  for (const k of ['hargaAwal', 'bphtb', 'ajbBbn', 'uangMuka', 'fasilitasTambahan']) if (k in b) data[k] = b[k];
  if ('pembeli' in b) data.pembeli = { ...PEMBELI_KOSONG, ...(base.pembeli ?? {}), ...b.pembeli };
  return data;
};

export async function create(actor, b) {
  const id = await db.transaction(async (tx) => {
    const [pt] = await tx.select().from(masterPt).where(eq(masterPt.id, b.ptId)).limit(1);
    if (!pt || pt.deletedAt) throw new AppError('PT tidak ditemukan.', 422);
    const [unit] = await tx.select().from(trkUnits).where(eq(trkUnits.id, b.kavlingId)).limit(1);
    if (!unit || unit.isDeleted) throw new AppError('Kavling tidak ditemukan.', 422);

    let tipe = b.tipeTransaksi;
    let pembeliDefault = {};
    if (b.assignmentId) {
      const { a, customer } = await findAssignment(tx, b.assignmentId);
      if (a.unitId !== unit.id) throw new AppError('Penjualan PR Track tersebut bukan untuk kavling ini.', 422);
      tipe = tipe ?? TIPE_DARI_TRACK[a.tipePembayaran];
      pembeliDefault = { nama: customer.nama, alamat: customer.alamat ?? '', noHp: customer.noHp ?? '', noKtp: customer.noKtp ?? '', pekerjaan: customer.pekerjaan ?? '' };
    }
    if (!tipe) throw new AppError('Tipe transaksi wajib diisi.', 422);

    const template = await pilihTemplate(tx, { templateId: b.templateId, ptId: pt.id, tipe });
    const [d] = await tx.insert(dokumen).values({
      noDokumen: await nomorDokumen(tx, { pt, template, tipe, tanggal: b.tanggalPerjanjian }),
      ptId: pt.id, unitId: unit.id, assignmentId: b.assignmentId ?? null, templateId: template?.id ?? null,
      tipeTransaksi: tipe, tanggal: b.tanggalPerjanjian, status: 'draft',
      data: toData({ ...b, pembeli: { ...pembeliDefault, ...(b.pembeli ?? {}) } }),
    }).returning();

    // Pasal disalin dari template; pustaka berikutnya berubah, dokumen ini tidak
    if (template) {
      const rows = await tx.select({ p: pasal, urutan: templatePasal.urutan }).from(templatePasal)
        .innerJoin(pasal, eq(pasal.id, templatePasal.pasalId))
        .where(eq(templatePasal.templateId, template.id)).orderBy(asc(templatePasal.urutan));
      if (rows.length) {
        await tx.insert(dokumenPasal).values(rows.map(({ p }, i) => ({
          dokumenId: d.id, pustakaId: p.id, urutan: i + 1, judul: p.judul, teks: p.isi,
          nilaiField: (p.fields ?? []).map((f) => ({ ...f, nilai: '' })),
        })));
      }
    }
    await recordAuditTx(tx, { ...actor, action: AuditAction.CREATE, entity: 'dokumen', entityId: d.id, summary: d.noDokumen });
    await logStatus(tx, actor, d.id, 'draft');
    return d.id;
  });
  if (b.status === 'final') return finalisasi(actor, id);
  return get(id);
}

async function lockDraft(tx, id) {
  const [d] = await tx.select().from(dokumen).where(eq(dokumen.id, id)).for('update').limit(1);
  if (!d) throw new AppError('Dokumen tidak ditemukan.', 404);
  if (d.status !== 'draft') throw new AppError('Dokumen sudah final. Perubahan nilai dan jadwal lewat adendum.', 409);
  return d;
}

export async function updateDataUtama(actor, id, b) {
  await db.transaction(async (tx) => {
    const d = await lockDraft(tx, id);
    const values = { data: toData(b, d.data), updatedAt: new Date() };
    if ('tanggalPerjanjian' in b) values.tanggal = b.tanggalPerjanjian;
    if ('assignmentId' in b) {
      if (b.assignmentId) {
        const { a } = await findAssignment(tx, b.assignmentId);
        if (a.unitId !== d.unitId) throw new AppError('Penjualan PR Track tersebut bukan untuk kavling ini.', 422);
      }
      values.assignmentId = b.assignmentId ?? null;
    }
    await tx.update(dokumen).set(values).where(eq(dokumen.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.UPDATE, entity: 'dokumen', entityId: id, summary: 'Data utama diubah', metadata: { sebelum: d.data } });
  });
  return get(id);
}

export async function remove(actor, id) {
  await db.transaction(async (tx) => {
    const d = await lockDraft(tx, id);
    const [file] = await tx.select({ id: lampiran.id }).from(lampiran).where(and(eq(lampiran.entityType, 'dokumen'), eq(lampiran.entityId, id))).limit(1);
    if (file) throw new AppError('Hapus lampiran dokumen terlebih dahulu.', 409);
    await tx.delete(dokumen).where(eq(dokumen.id, id));
    await recordAuditTx(tx, { ...actor, action: AuditAction.DELETE, entity: 'dokumen', entityId: id, summary: d.noDokumen });
  });
}

// ── Pasal di dokumen ────────────────────────────────────────

async function renumber(tx, dokumenId, orderedIds) {
  for (const [i, pid] of orderedIds.entries()) {
    await tx.update(dokumenPasal).set({ urutan: i + 1 }).where(eq(dokumenPasal.id, pid));
  }
}

const pasalIdsOf = async (tx, dokumenId) =>
  (await tx.select({ id: dokumenPasal.id }).from(dokumenPasal).where(eq(dokumenPasal.dokumenId, dokumenId)).orderBy(asc(dokumenPasal.urutan)))
    .map((r) => r.id);

export async function addPasal(actor, id, b) {
  await db.transaction(async (tx) => {
    await lockDraft(tx, id);
    let item = { judul: b.judul, teks: b.isi, nilaiField: (b.fields ?? []).map((f) => ({ ...f, id: f.id ?? randomUUID(), nilai: f.nilai ?? '' })), pustakaId: null };
    if (b.pustakaId) {
      const [p] = await tx.select().from(pasal).where(eq(pasal.id, b.pustakaId)).limit(1);
      if (!p) throw new AppError('Pasal pustaka tidak ditemukan.', 422);
      item = { judul: p.judul, teks: p.isi, nilaiField: (p.fields ?? []).map((f) => ({ ...f, nilai: '' })), pustakaId: p.id };
    }
    if (!item.judul || !item.teks) throw new AppError('Judul dan isi pasal wajib diisi.', 422);
    const ids = await pasalIdsOf(tx, id);
    const [created] = await tx.insert(dokumenPasal).values({ dokumenId: id, urutan: ids.length + 1, ...item }).returning();
    const at = b.index === undefined ? ids.length : Math.min(Math.max(b.index, 0), ids.length);
    ids.splice(at, 0, created.id);
    await renumber(tx, id, ids);
  });
  return get(id);
}

async function findPasalDokumen(tx, id, pasalId) {
  const [p] = await tx.select().from(dokumenPasal).where(and(eq(dokumenPasal.id, pasalId), eq(dokumenPasal.dokumenId, id))).limit(1);
  if (!p) throw new AppError('Pasal tidak ditemukan di dokumen ini.', 404);
  return p;
}

export async function updatePasal(actor, id, pasalId, b) {
  await db.transaction(async (tx) => {
    await lockDraft(tx, id);
    const p = await findPasalDokumen(tx, id, pasalId);
    const values = {};
    if ('judul' in b) values.judul = b.judul;
    if ('isi' in b) values.teks = b.isi;
    if (b.fieldValues) {
      values.nilaiField = p.nilaiField.map((f) => (f.key in b.fieldValues ? { ...f, nilai: String(b.fieldValues[f.key] ?? '') } : f));
    }
    await tx.update(dokumenPasal).set(values).where(eq(dokumenPasal.id, pasalId));
  });
  return get(id);
}

export async function removePasal(actor, id, pasalId) {
  await db.transaction(async (tx) => {
    await lockDraft(tx, id);
    await findPasalDokumen(tx, id, pasalId);
    await tx.delete(dokumenPasal).where(eq(dokumenPasal.id, pasalId));
    await renumber(tx, id, await pasalIdsOf(tx, id));
  });
  return get(id);
}

export async function reorderPasal(actor, id, orderedIds) {
  await db.transaction(async (tx) => {
    await lockDraft(tx, id);
    const current = await pasalIdsOf(tx, id);
    if (current.length !== orderedIds.length || current.some((x) => !orderedIds.includes(x))) {
      throw new AppError('Urutan harus memuat semua pasal dokumen ini, masing-masing sekali.', 422);
    }
    await renumber(tx, id, orderedIds);
  });
  return get(id);
}

// ── Jadwal DP ───────────────────────────────────────────────

export async function setJadwal(actor, id, b) {
  await db.transaction(async (tx) => {
    await lockDraft(tx, id);
    let jadwal = null;
    if (b) {
      const baris = (b.baris ?? hitungJadwal(b)).map((r) => ({ id: r.id ?? randomUUID(), tanggal: r.tanggal, jumlah: r.jumlah, keterangan: r.keterangan ?? '' }));
      if (!baris.length) throw new AppError('Jadwal kosong: periksa tanggal mulai dan jatuh tempo terakhir.', 422);
      jadwal = {
        tanggalAcuan: String(b.tanggalAcuan), nominalPerBulan: b.nominalPerBulan, tanggalMulai: b.tanggalMulai,
        jatuhTempoTerakhir: b.jatuhTempoTerakhir, baris,
      };
    }
    await tx.update(dokumen).set({ jadwal, updatedAt: new Date() }).where(eq(dokumen.id, id));
  });
  return get(id);
}

export async function updateBarisJadwal(actor, id, barisId, jumlah) {
  await db.transaction(async (tx) => {
    const d = await lockDraft(tx, id);
    if (!d.jadwal?.baris?.some((r) => r.id === barisId)) throw new AppError('Baris jadwal tidak ditemukan.', 404);
    const jadwal = { ...d.jadwal, baris: d.jadwal.baris.map((r) => (r.id === barisId ? { ...r, jumlah } : r)) };
    await tx.update(dokumen).set({ jadwal, updatedAt: new Date() }).where(eq(dokumen.id, id));
  });
  return get(id);
}

// ── Finalisasi ──────────────────────────────────────────────

function cekFinal(d) {
  const errors = [];
  const data = d.data ?? {};
  if (!d.assignmentId) errors.push('Hubungkan dokumen ke penjualan PR Track (assignmentId) sebelum final.');
  if (!data.pembeli?.nama) errors.push('Nama pembeli wajib diisi.');
  if (!(Number(data.hargaAwal) > 0)) errors.push('Harga awal harus lebih dari 0.');
  const um = toCents(data.uangMuka ?? 0);
  const totalJadwal = (d.jadwal?.baris ?? []).reduce((s, r) => s + toCents(r.jumlah), 0n);
  if (um > 0n && totalJadwal !== um) {
    errors.push(`Total jadwal (${centsToString(totalJadwal)}) harus sama dengan uang muka (${centsToString(um)}).`);
  }
  const nett = toCents(data.hargaAwal ?? 0) + toCents(data.bphtb ?? 0) + toCents(data.ajbBbn ?? 0);
  if (um > nett) errors.push('Uang muka melebihi harga nett.');
  return { errors, nett };
}

export async function finalisasi(actor, id) {
  await db.transaction(async (tx) => {
    const d = await lockDraft(tx, id);
    const { errors, nett } = cekFinal(d);
    if (errors.length) throw new AppError(errors.length === 1 ? errors[0] : 'Dokumen belum bisa difinalkan.', 422, errors);

    const { a, unit, customer } = await findAssignment(tx, d.assignmentId);
    if (a.unitId !== d.unitId) throw new AppError('Penjualan PR Track bukan untuk kavling dokumen ini.', 422);

    const [existing] = await tx.select().from(penjualanKeuangan).where(eq(penjualanKeuangan.assignmentId, a.id)).for('update').limit(1);
    if (existing?.dokumenId && existing.status === 'aktif') {
      throw new AppError('Penjualan ini sudah punya SPPR final. Perubahan lewat adendum.', 409);
    }
    const values = { assignmentId: a.id, dokumenId: d.id, nilaiSppr: centsToString(nett), status: 'aktif', updatedAt: new Date() };
    const [pj] = existing
      ? await tx.update(penjualanKeuangan).set(values).where(eq(penjualanKeuangan.id, existing.id)).returning()
      : await tx.insert(penjualanKeuangan).values(values).returning();

    const baris = d.jadwal?.baris ?? [];
    if (baris.length) {
      const inserted = await tx.insert(jadwalAngsuran).values(baris.map((r, i) => ({
        penjualanId: pj.id, assignmentId: a.id, dokumenId: d.id, noUrut: i + 1, tanggal: r.tanggal,
        jumlah: centsToString(toCents(r.jumlah)), keterangan: r.keterangan || `DP ${i + 1}`,
      }))).returning();
      // Dikirim worker ke PR Track (RancanganSistem bagian 6)
      await tx.insert(outboxTrack).values(inserted.map((j) => ({
        jenis: 'jadwal_angsuran', refId: j.id,
        payload: { siJadwalId: j.id, trackAssignmentId: a.trackId, noUrut: j.noUrut, tanggal: j.tanggal, jumlah: toNumber(j.jumlah), keterangan: j.keterangan, aktif: true },
      })));
    }

    // Booking fee yang sudah masuk pindah dari titipan ke uang muka penjualan
    const kp = await kodePembantuPembeli(tx, customer, unit.projectId);
    const titipan = await akunPeran(tx, 'titipan_booking_fee');
    const saldoBf = await saldoAkunKp(tx, { akunId: titipan.id, kodePembantuId: kp.id, proyekId: unit.projectId });
    if (saldoBf > 0n) {
      const uangMuka = await akunPeran(tx, 'uang_muka_penjualan');
      const nominal = Number(centsToString(saldoBf));
      await buatJurnal(tx, actor, {
        tanggal: d.tanggal, uraian: `SPPR ${d.noDokumen} final: booking fee ${customer.nama} menjadi uang muka`,
        proyekId: unit.projectId, status: 'diposting', sumber: 'penjualan', refType: 'dokumen', refId: d.id, noReferensi: d.noDokumen,
        rows: [
          { akunId: titipan.id, kodePembantuId: kp.id, debit: nominal, kredit: 0 },
          { akunId: uangMuka.id, kodePembantuId: kp.id, debit: 0, kredit: nominal },
        ],
      });
    }

    await tx.update(dokumen).set({ status: 'final', difinalkanOleh: actor.userId, difinalkanPada: new Date(), updatedAt: new Date() })
      .where(eq(dokumen.id, id));
    await logStatus(tx, actor, id, 'final');
  });
  return get(id);
}

export async function tandatangani(actor, id) {
  await db.transaction(async (tx) => {
    const [d] = await tx.select().from(dokumen).where(eq(dokumen.id, id)).for('update').limit(1);
    if (!d) throw new AppError('Dokumen tidak ditemukan.', 404);
    if (d.status !== 'final') throw new AppError('Hanya dokumen final yang bisa ditandai ditandatangani.', 409);
    await tx.update(dokumen).set({ status: 'ditandatangani', updatedAt: new Date() }).where(eq(dokumen.id, id));
    await logStatus(tx, actor, id, 'ditandatangani');
  });
  return get(id);
}

/** Penjualan Track yang bisa dipilih untuk SPPR (belum punya SPPR final). */
export async function penjualanTersedia({ proyekId }) {
  const rows = await db.execute(sql`
    SELECT a.id, a.tipe_pembayaran, a.harga, a.uang_muka, a.tanggal, u.id unit_id, u.kode unit_kode, u.project_id,
           c.nama, c.no_hp, c.alamat
    FROM finance.trk_assignments a
    JOIN finance.trk_units u ON u.id = a.unit_id
    JOIN finance.trk_customers c ON c.id = a.customer_id
    LEFT JOIN finance.penjualan_keuangan pk ON pk.assignment_id = a.id AND pk.status = 'aktif' AND pk.dokumen_id IS NOT NULL
    WHERE a.is_deleted = false AND pk.id IS NULL ${proyekId ? sql`AND u.project_id = ${proyekId}` : sql``}
    ORDER BY u.kode
  `);
  return rows.map((r) => ({
    assignmentId: r.id, kavlingId: r.unit_id, kavling: r.unit_kode, perumahanId: r.project_id,
    tipeTransaksi: TIPE_TRANSAKSI_LABEL[TIPE_DARI_TRACK[r.tipe_pembayaran]] ?? null,
    hargaTrack: toNumber(r.harga), uangMukaTrack: toNumber(r.uang_muka), tanggal: r.tanggal,
    pembeli: { nama: r.nama, noHp: r.no_hp ?? '', alamat: r.alamat ?? '' },
  }));
}

