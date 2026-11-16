/**
 * Type réel d'un fichier reçu, d'après sa signature (jamais d'après son nom ni l'en-tête annoncé) : photos et
 * documents du lot 07. Les deux marques HEIF se valent (un fichier annoncé HEIC peut porter la marque « mif1 »).
 */
export type DetectedType =
	| 'image/jpeg'
	| 'image/png'
	| 'image/webp'
	| 'image/heic'
	| 'image/heif'
	| 'application/pdf'
	| 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Lot 08 bis : un .docx est un zip ; son contenu est contrôlé ensuite en entier (template-inspection.ts). */
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function detectFileType(body: Buffer): DetectedType | null {
	if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
	if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (body.length >= 12 && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP')
		return 'image/webp';
	if (body.length >= 12 && body.subarray(4, 8).toString('latin1') === 'ftyp') {
		const brand = body.subarray(8, 12).toString('latin1');
		if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
		if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
	}
	if (body.length >= 5 && body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
	if (body.length >= 4 && body.readUInt32LE(0) === 0x04034b50) return DOCX;
	return null;
}

/** Le type annoncé correspond-il au contenu ? */
export function matchesDeclared(declared: string, detected: DetectedType | null): boolean {
	if (!detected) return false;
	const heif = (t: string) => t === 'image/heic' || t === 'image/heif';
	return declared === detected || (heif(declared) && heif(detected));
}
