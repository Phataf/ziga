import { inspectionCheckboxLabel, inspectionPhotoDatesLabel, inspectionPhotoLateLabel } from '@ziga/shared/exit-schemas';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectPdf } from '../../../test/pdf-inspect.js';
import { inspectionReportPdf } from './inspection-report-pdf.js';

describe('PDF de l’état des lieux (lot 10 bis, étape 4)', () => {
	it('pièces, constats, photos avec leurs dates, mention de la photo reçue après la signature, cases cochées', async () => {
		const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 60 } } })
			.jpeg()
			.toBuffer();
		const bytes = await inspectionReportPdf({
			title: 'État des lieux de sortie',
			organizationName: 'Faso Immobilier',
			details: ['Résidence Laafi · S1', 'Locataire : Salif Traoré', 'État des lieux du 21/11/2026'],
			rooms: [
				{
					name: 'Douche et WC',
					items: [
						{
							element: 'Douche',
							finding: 'Dégradation imputable au locataire',
							description: 'Pommeau arraché, flexible coupé',
							photos: [
								{
									image: { bytes: jpeg, type: 'image/jpeg' },
									dates: inspectionPhotoDatesLabel({ takenAt: '2026-11-21T09:00:00.000Z', receivedAt: '2026-11-21T09:00:05.000Z' }),
									late: null
								},
								{
									image: { bytes: jpeg, type: 'image/jpeg' },
									dates: inspectionPhotoDatesLabel({ takenAt: '2026-11-21T09:10:00.000Z', receivedAt: '2026-11-21T11:42:00.000Z' }),
									late: inspectionPhotoLateLabel('2026-11-21T11:42:00.000Z')
								}
							]
						}
					]
				}
			],
			signatures: [
				inspectionCheckboxLabel({ signerName: 'Awa Ouédraogo', signedAt: '2026-11-21T09:30:00.000Z', deviceOwnerName: 'Awa Ouédraogo' }),
				inspectionCheckboxLabel({ signerName: 'Salif Traoré', signedAt: '2026-11-21T09:31:00.000Z', deviceOwnerName: 'Awa Ouédraogo' })
			],
			footer: 'État des lieux de sortie · Résidence Laafi · S1'
		});
		const text = (await inspectPdf(bytes)).pages.flatMap((p) => p.text).join('\n');
		expect(text).toContain('État des lieux de sortie');
		expect(text).toContain('Douche — Dégradation imputable au locataire');
		expect(text).toContain('Prise le 21/11/2026 à 09:00, reçue le 21/11/2026 à 09:00');
		expect(text).toContain('Photo reçue après la signature, le 21/11/2026 à 11:42');
		expect(text.match(/Photo reçue après la signature/g)).toHaveLength(1);
		expect(text).toContain('Case cochée par Salif Traoré le 21/11/2026 à 09:31 sur l’appareil de Awa Ouédraogo');
		expect(text).not.toMatch(/électronique/i);
		expect(text).toContain('page 1 sur 1');
	});
});
