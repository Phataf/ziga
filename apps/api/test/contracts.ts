/**
 * Contrats de test (lot 08 bis), écrits en SQL dans le contexte d'une organisation (client déjà dans sa transaction
 * de contexte) : documents actifs avec leur empreinte, modèles, contrats, versions et avenants.
 */
import { createHash } from 'node:crypto';
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocumentExtra {
	type: string;
	leaseId?: string | null;
	leaseContractId?: string | null;
	contractTemplateId?: string | null;
	mimeType?: string;
	/** Laisser le document en attente de son fichier. */
	pending?: boolean;
}

/** Un document du registre, activé avec son empreinte (comme après la vérification du fichier par le serveur). */
export async function insertDocument(
	c: pg.Client,
	organizationId: string,
	uploadedBy: string,
	extra: DocumentExtra
): Promise<{ id: string; sha256: string }> {
	const id = newId();
	const sha256 = createHash('sha256').update(id).digest('hex');
	await c.query(
		`insert into documents (id, organization_id, type, lease_id, lease_contract_id, contract_template_id, file_name, mime_type, byte_size,
			storage_key, uploaded_by)
		 values ($1, $2, $3, $4, $5, $6, 'fichier', $7, 1000, $8, $9)`,
		[
			id,
			organizationId,
			extra.type,
			extra.leaseId ?? null,
			extra.leaseContractId ?? null,
			extra.contractTemplateId ?? null,
			extra.mimeType ?? 'application/pdf',
			`documents/${id}`,
			uploadedBy
		]
	);
	if (!extra.pending) {
		await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [id, sha256]);
	}
	return { id, sha256 };
}

/** Un modèle Word brouillon et son fichier (clé étrangère différée : les deux se citent). */
export async function insertTemplate(
	c: pg.Client,
	organizationId: string,
	userId: string,
	kind: 'lease' | 'amendment' = 'lease'
): Promise<{ id: string; documentId: string }> {
	const id = newId();
	const documentId = newId();
	await c.query(
		`insert into contract_templates (id, organization_id, kind, name, document_id, created_by) values ($1, $2, $3, 'Modèle de test', $4, $5)`,
		[id, organizationId, kind, documentId, userId]
	);
	await c.query(
		`insert into documents (id, organization_id, type, contract_template_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
		 values ($1, $2, 'contract_template', $3, 'modele.docx', $4, 1000, $5, $6)`,
		[documentId, organizationId, id, DOCX, `documents/${documentId}`, userId]
	);
	await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [
		documentId,
		createHash('sha256').update(documentId).digest('hex')
	]);
	return { id, documentId };
}

/** Un contrat généré, brouillon, avec le modèle de la plateforme. */
export async function insertContract(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	userId: string,
	extra: { amendmentId?: string | null } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into lease_contracts (id, organization_id, lease_id, amendment_id, origin, template_source, template_version, status,
			signing_place, signing_date, copies, created_by)
		 values ($1, $2, $3, $4, 'generated', 'platform', 1, 'draft', 'Ouagadougou', '2026-11-15', 3, $5)`,
		[id, organizationId, leaseId, extra.amendmentId ?? null, userId]
	);
	return id;
}

/** La version suivante d'un contrat : projets Word et PDF actifs, puis la version, puis le contrat qui la cite. */
export async function addVersion(
	c: pg.Client,
	organizationId: string,
	contractId: string,
	leaseId: string,
	userId: string
): Promise<number> {
	const docx = await insertDocument(c, organizationId, userId, {
		type: 'contract_draft',
		leaseId,
		leaseContractId: contractId,
		mimeType: DOCX
	});
	const pdf = await insertDocument(c, organizationId, userId, { type: 'contract_draft', leaseId, leaseContractId: contractId });
	const r = await c.query(`select current_version from lease_contracts where id = $1`, [contractId]);
	const next = (r.rows[0].current_version as number) + 1;
	await c.query(
		`insert into contract_versions (id, organization_id, contract_id, number, lease_version, template_source, template_version, data, fields,
			docx_document_id, pdf_document_id, docx_sha256, pdf_sha256, created_by)
		 values ($1, $2, $3, $4, 1, 'platform', 1, '{}', '{}', $5, $6, $7, $8, $9)`,
		[newId(), organizationId, contractId, next, docx.id, pdf.id, docx.sha256, pdf.sha256, userId]
	);
	await c.query(`update lease_contracts set current_version = $2 where id = $1`, [contractId, next]);
	return next;
}

/** Brouillon → vérification → prêt à signer (version courante figée). */
export async function freeze(c: pg.Client, contractId: string, userId: string): Promise<void> {
	await c.query(`update lease_contracts set status = 'in_review' where id = $1`, [contractId]);
	await c.query(
		`update lease_contracts set status = 'ready_to_sign', frozen_version = current_version, frozen_at = now(), frozen_by = $2,
			expected_signers = array['organization', 'tenant'] where id = $1`,
		[contractId, userId]
	);
}

/** Dépôt du scan signé d'un contrat prêt à signer. */
export async function sign(c: pg.Client, organizationId: string, contractId: string, leaseId: string, userId: string): Promise<string> {
	const scan = await insertDocument(c, organizationId, userId, { type: 'signed_lease_scan', leaseId, leaseContractId: contractId });
	await c.query(
		`update lease_contracts set status = 'signed', signature_mode = 'handwritten_scan', signed_document_id = $2, signature_recorded_by = $3,
			signature_recorded_at = now(), organization_signed_on = '2026-11-15', tenant_signed_on = '2026-11-15' where id = $1`,
		[contractId, scan.id, userId]
	);
	return scan.id;
}

export async function insertAmendment(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	userId: string,
	extra: { number?: number; type?: 'rent_change' | 'renewal' | 'other'; values?: Record<string, unknown> } = {}
): Promise<string> {
	const id = newId();
	const type = extra.type ?? 'rent_change';
	const values = {
		new_rent: type === 'rent_change' ? 80_000 : null,
		new_charges: type === 'rent_change' ? 5_000 : null,
		new_ends_on: null,
		open_ended: type === 'renewal',
		description: type === 'other' ? 'Ajout d’un garage' : null,
		...extra.values
	};
	await c.query(
		`insert into lease_amendments (id, organization_id, lease_id, number, type, effective_from, new_rent, new_charges, new_ends_on, open_ended,
			description, expected_lease_version, created_by)
		 values ($1, $2, $3, $4, $5, '2026-07-01', $6, $7, $8, $9, $10, 1, $11)`,
		[
			id,
			organizationId,
			leaseId,
			extra.number ?? 1,
			type,
			values.new_rent,
			values.new_charges,
			values.new_ends_on,
			values.open_ended,
			values.description,
			userId
		]
	);
	return id;
}
