/** Noms des files BullMQ. Les tâches lourdes (PDF, images, relances, échéances en masse) passent par elles. */
export const EXAMPLE_QUEUE = 'example';

export interface ExampleJobData {
	/** Texte à traiter, pour vérifier le branchement de bout en bout. */
	message: string;
}

export interface ExampleJobResult {
	length: number;
	processedBy: number;
}

/** Logos des organisations (lot 03) : versions WebP (web) et PNG (PDF, pdf-lib) produites par sharp. */
export const LOGO_QUEUE = 'organization-logos';

export interface LogoJobData {
	organizationId: string;
	logoId: string;
}
