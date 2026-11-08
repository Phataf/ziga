/**
 * Fichiers du logo (lot 03, D29). Clés de stockage déterministes, jamais réécrites :
 *   logos/<organization_id>/<logo_id>/original   (privé, jamais servi)
 *   logos/<organization_id>/<logo_id>/web.webp   (public : écrans, liens de reçus, vitrine)
 *   logos/<organization_id>/<logo_id>/print.png  (public : PDF, pdf-lib n'accepte que PNG et JPEG)
 */
import { LOGO_MAX_BYTES, LOGO_MIME_TYPES, type LogoMimeType } from '@ziga/shared/organizations';
import sharp from 'sharp';
import { AppError } from '../../common/app-error.js';

export type LogoVariant = 'web.webp' | 'print.png';
export const LOGO_VARIANTS: Record<LogoVariant, string> = { 'web.webp': 'image/webp', 'print.png': 'image/png' };

export function logoKey(organizationId: string, logoId: string, file: 'original' | LogoVariant): string {
	return `logos/${organizationId}/${logoId}/${file}`;
}

/** Signature des formats acceptés : le type annoncé doit correspondre au contenu (un SVG est toujours refusé). */
export function detectLogoType(body: Buffer): LogoMimeType | null {
	if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
	if (body.length >= 12 && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP')
		return 'image/webp';
	return null;
}

export function assertLogo(contentType: string | undefined, body: Buffer): LogoMimeType {
	if (body.length === 0) throw new AppError('LOGO_EMPTY', 'Choisissez une image.', 400);
	if (body.length > LOGO_MAX_BYTES) throw new AppError('LOGO_TOO_LARGE', 'Le logo dépasse 2 Mo.', 413);
	const declared = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	const detected = detectLogoType(body);
	if (!detected || !(LOGO_MIME_TYPES as readonly string[]).includes(declared) || detected !== declared) {
		throw new AppError('LOGO_TYPE', 'Format refusé : PNG, JPEG ou WebP seulement (SVG refusé).', 415);
	}
	return detected;
}

/** Versions du logo : métadonnées retirées, orientation appliquée, jamais agrandi. */
export async function renderLogo(original: Buffer): Promise<{ web: Buffer; print: Buffer; width: number; height: number }> {
	const base = () => sharp(original, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate();
	const web = await base().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
	const { data: print, info } = await base()
		.resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
		.png({ compressionLevel: 9 })
		.toBuffer({ resolveWithObject: true });
	return { web, print, width: info.width, height: info.height };
}
