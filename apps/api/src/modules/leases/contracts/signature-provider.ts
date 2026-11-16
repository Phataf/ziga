/**
 * Signature d'un contrat derrière une interface (D21, lot 08 bis). Au MVP, une seule implémentation : la signature
 * manuscrite, puis le scan déposé (`handwritten_scan`). Un PDF déposé n'est jamais présenté comme une signature
 * électronique : son libellé est toujours « Signature manuscrite, scan déposé par … le … ». Une signature qualifiée
 * (prestataire agréé ou FasoSign) viendra en phase 3 par une autre implémentation, sans toucher au reste.
 */
import { signatureLabel, type ContractParty, type SignatureMode } from '@ziga/shared/contracts';

export interface SignatureRecordInput {
	contractId: string;
	documentId: string;
	signedOn: Readonly<Record<ContractParty, string | null>>;
	recordedByName: string | null;
	recordedAt: Date;
}

export interface SignatureRecord {
	mode: SignatureMode;
	/** Libellé affiché partout (écrans, chronologie, audit). */
	label: string;
}

export interface SignatureProvider {
	readonly mode: SignatureMode;
	record(input: SignatureRecordInput): Promise<SignatureRecord>;
}

export const SIGNATURE_PROVIDER = Symbol('SIGNATURE_PROVIDER');

export class HandwrittenScanProvider implements SignatureProvider {
	readonly mode = 'handwritten_scan' as const;

	async record(input: SignatureRecordInput): Promise<SignatureRecord> {
		return { mode: this.mode, label: signatureLabel({ recordedBy: input.recordedByName, recordedAt: input.recordedAt }) };
	}
}
