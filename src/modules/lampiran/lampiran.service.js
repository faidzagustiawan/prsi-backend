// src/modules/lampiran/lampiran.service.js
//
// Berkas disimpan di disk server SI (UPLOAD_DIR), metadata di tabel lampiran.
// Jenis berkas dicek dari isinya (magic bytes), bukan dari nama atau header
// Content-Type yang dikirim browser.
import { createWriteStream } from 'node:fs';
import { mkdir, unlink, stat, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { env } from '../../config/env.js';
import { lampiran } from '../../shared/schemas/akuntansi.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { recordAudit, AuditAction } from '../../shared/utils/audit.js';
import { LAMPIRAN_MAKS_BYTES } from '../../shared/constants.js';
import { toLampiranDto } from '../jurnal/jurnal.service.js';
import * as jurnalRepo from '../jurnal/jurnal.repository.js';

const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function sniffMime(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Pemilik lampiran yang didukung. Lampiran jurnal yang sudah dibukukan
// tidak boleh dihapus karena menjadi bukti posting.
const OWNERS = {
  jurnal: {
    async assertWritable(entityId, { forDelete = false } = {}) {
      const j = await jurnalRepo.findJurnal(entityId);
      if (!j) throw new AppError('Jurnal tidak ditemukan.', 404);
      if (forDelete && j.status !== 'draft') {
        throw new AppError('Lampiran jurnal yang sudah diposting tidak bisa dihapus.', 409);
      }
      if (['dikoreksi', 'balik'].includes(j.status)) {
        throw new AppError('Jurnal ini sudah dikoreksi.', 409);
      }
    },
  },
};

const ownerOf = (entityType) => {
  const owner = OWNERS[entityType];
  if (!owner) throw new AppError('Jenis lampiran tidak dikenal.', 400);
  return owner;
};

const absolutePath = (rel) => path.join(env.uploadDir, rel);

async function readHead(fullPath, bytes = 16) {
  const handle = await open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Simpan satu berkas dari multipart (field "file"). */
export async function upload(request, { entityType, entityId }) {
  await ownerOf(entityType).assertWritable(entityId);

  const file = await request.file({ limits: { fileSize: LAMPIRAN_MAKS_BYTES, files: 1 } });
  if (!file) throw new AppError('Berkas wajib dikirim pada field "file".', 400);

  const now = new Date();
  const dir = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  await mkdir(absolutePath(dir), { recursive: true });

  const id = randomUUID();
  const tmpRel = path.join(dir, `${id}.upload`);
  await pipeline(file.file, createWriteStream(absolutePath(tmpRel)));

  const cleanup = () => unlink(absolutePath(tmpRel)).catch(() => {});
  if (file.file.truncated) {
    await cleanup();
    throw new AppError(`Ukuran berkas melebihi ${LAMPIRAN_MAKS_BYTES / 1024 / 1024} MB.`, 413);
  }

  const head = await readHead(absolutePath(tmpRel));
  const mime = sniffMime(head);
  if (!mime) {
    await cleanup();
    throw new AppError('Format berkas tidak didukung. Gunakan PDF, JPG, PNG, atau WEBP.', 415);
  }

  const rel = path.join(dir, `${id}.${EXT[mime]}`);
  await rename(absolutePath(tmpRel), absolutePath(rel));
  const { size } = await stat(absolutePath(rel));

  const namaFile = path.basename(file.filename || `lampiran.${EXT[mime]}`).slice(0, 255);
  const [row] = await db.insert(lampiran).values({
    id, entityType, entityId, namaFile, path: rel.split(path.sep).join('/'), mime, ukuran: size,
    diunggahOleh: request.user.sub,
  }).returning();

  await recordAudit({
    request, action: AuditAction.CREATE, entity: 'lampiran', entityId: id,
    summary: `${namaFile} untuk ${entityType} ${entityId}`,
  });
  return toLampiranDto(row);
}

export async function listFor({ entityType, entityId }) {
  ownerOf(entityType);
  const rows = await db.select().from(lampiran)
    .where(and(eq(lampiran.entityType, entityType), eq(lampiran.entityId, entityId)))
    .orderBy(lampiran.createdAt);
  return rows.map(toLampiranDto);
}

export async function findForDownload(id) {
  const [row] = await db.select().from(lampiran).where(eq(lampiran.id, id)).limit(1);
  if (!row) throw new AppError('Lampiran tidak ditemukan.', 404);
  return { row, fullPath: absolutePath(row.path) };
}

export async function remove(request, id) {
  const [row] = await db.select().from(lampiran).where(eq(lampiran.id, id)).limit(1);
  if (!row) throw new AppError('Lampiran tidak ditemukan.', 404);
  await ownerOf(row.entityType).assertWritable(row.entityId, { forDelete: true });

  await db.delete(lampiran).where(eq(lampiran.id, id));
  await unlink(absolutePath(row.path)).catch(() => {});
  await recordAudit({ request, action: AuditAction.DELETE, entity: 'lampiran', entityId: id, summary: row.namaFile });
}
