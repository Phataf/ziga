<script lang="ts">
	/** État d'un import (lot 11), en mots. */
	import type { ImportJobStatus } from '@ziga/shared/imports';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.ts';
	import { fr } from '#lib/i18n/fr.ts';

	let { status }: { status: ImportJobStatus } = $props();
	const TONES: Record<ImportJobStatus, BadgeVariant> = {
		uploaded: 'info',
		analyzing: 'info',
		analyzed: 'warning',
		analysis_failed: 'danger',
		running: 'info',
		completed: 'success',
		failed: 'danger',
		cancelled: 'secondary'
	};
</script>

<Badge variant={TONES[status]} data-testid="etat-import">{fr.imports.status[status]}</Badge>
