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
