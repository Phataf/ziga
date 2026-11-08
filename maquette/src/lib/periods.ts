/** « aaaa-mm » décalé de `delta` mois. */
export function shiftPeriod(period: string, delta: number): string {
	const d = new Date(+period.slice(0, 4), +period.slice(5, 7) - 1 + delta, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Les trois derniers mois, le plus ancien d'abord, mois en cours compris. */
export function lastPeriods(today: string, n = 3): string[] {
	const cur = today.slice(0, 7);
	return Array.from({ length: n }, (_, i) => shiftPeriod(cur, i - n + 1));
}

/** « de novembre 2026 », « d’octobre 2026 » (élision devant une voyelle). */
export function ofMonth(period: string, formatter: (p: string) => string): string {
	const m = formatter(period);
	return /^[aeiouâéè]/i.test(m) ? `d’${m}` : `de ${m}`;
}
