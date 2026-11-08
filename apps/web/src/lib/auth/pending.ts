/**
 * Inscription en cours, en mémoire de l'onglet seulement (jamais dans le stockage du navigateur) :
 * elle permet de renvoyer le code depuis l'écran de vérification. Effacée dès la vérification.
 */
export const pendingRegistration: { value: { phone: string; name: string; password: string } | null } = { value: null };
