// src/modules/track/track.repository.js
//
// SATU-SATUNYA pintu baca data PodorukunTrack.
// Hanya memanggil fungsi kontrak finance.track_* (lihat
// database/setup/003_track_functions.sql). Jangan pernah menulis query langsung
// ke tabel public.* di modul mana pun; role si_app memang tidak punya aksesnya.
import { sql } from 'drizzle-orm';
import { db } from '../../config/database.js';

export const listCompanies = () =>
  db.execute(sql`SELECT * FROM finance.track_companies() ORDER BY nama_pt`);

export const listUnits = (companyId) =>
  db.execute(sql`
    SELECT * FROM finance.track_units(${companyId}::uuid)
    ORDER BY nama_proyek, nama_cluster, nomor_unit
  `);

export const listAssignments = (companyId) =>
  db.execute(sql`
    SELECT * FROM finance.track_assignments(${companyId}::uuid)
    ORDER BY tanggal_pembelian DESC
  `);

export const listPaymentsSince = (companyId, since, limit = 500) =>
  db.execute(sql`
    SELECT * FROM finance.track_payments_since(${companyId}::uuid, ${since}::timestamptz, ${limit}::integer)
  `);
