/** Nom lisible d'un appareil, d'après son User-Agent (« Chrome sur Android »), pour « Mes appareils ». */
export function deviceLabel(userAgent: string | undefined): string {
	const ua = userAgent ?? '';
	const os = /Android/i.test(ua)
		? 'Android'
		: /iPhone|iPad|iPod/i.test(ua)
			? 'iPhone ou iPad'
			: /Windows/i.test(ua)
				? 'Windows'
				: /Mac OS X|Macintosh/i.test(ua)
					? 'Mac'
					: /Linux/i.test(ua)
						? 'Linux'
						: '';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /OPR\/|Opera/.test(ua)
			? 'Opera'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Chrome\/|CriOS\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: '';
	if (browser && os) return `${browser} sur ${os}`;
	return browser || os || 'Appareil inconnu';
}
