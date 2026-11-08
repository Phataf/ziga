# Lot 02 — Authentification

## Contexte
Les utilisateurs se connectent avec leur numéro de téléphone, comme dans les applications qu'ils connaissent. Le SMS coûte de l'argent : il ne sert qu'à vérifier le numéro à l'inscription et à récupérer un compte.

Le compte est celui d'une **personne** (D13) : le même compte sert au membre d'une organisation, au propriétaire et au locataire. Une personne peut n'appartenir à aucune organisation ; elle accède alors seulement à son espace personnel (vide jusqu'au lot 10 ter). Le numéro vérifié servira, au lot 10 ter, à lier ses fiches propriétaire et locataire dans les organisations.

## Prérequis
Lot 01 terminé.

## Périmètre
1. **Tables** (module `identity`) : `users` (id UUIDv7, téléphone E.164 unique, nom, mot de passe haché, statut, `phone_verified_at`, `platform_role` nullable), `sessions` (jeton de rafraîchissement haché, appareil, création, dernière utilisation, révocation), `otp_codes` (téléphone, code haché, objet, expiration, tentatives).
2. **Inscription** : téléphone + nom + mot de passe (8 caractères minimum), puis vérification du numéro par code à 6 chiffres.
3. **Connexion** : téléphone + mot de passe. Jeton d'accès de 15 minutes ; jeton de rafraîchissement de 30 jours en cookie `httpOnly`, `Secure`, `SameSite=Lax`, avec rotation à chaque usage et détection de réutilisation (réutilisation → toutes les sessions de l'utilisateur révoquées).
4. **Mot de passe oublié** : code par SMS, puis nouveau mot de passe ; toutes les autres sessions révoquées.
5. **Adaptateur SMS** (module `notifications`) : interface `SmsSender` + implémentation `console` (affiche le code dans les logs) ; l'implémentation réelle viendra plus tard.
6. **Protection** : hachage argon2id ; limitation de débit par téléphone et par IP (connexion, envoi de code) ; verrouillage temporaire après 5 échecs ; codes à usage unique, valides 10 minutes, 5 essais maximum ; réponses qui ne révèlent pas si un numéro existe.
7. **Rôles plateforme** : champ `platform_role` (`super_admin`, `support`, `sales`, `finance` ; les deux derniers sont utilisés au lot 04) ; le premier super administrateur est créé par une commande en ligne, jamais par l'interface.
8. **Gestion des sessions** : liste des appareils connectés et déconnexion d'un appareil.
9. **Écrans** : inscription, vérification, connexion, mot de passe oublié, mes appareils. Clavier téléphonique pour le numéro, préfixe `+226` affiché.

## Hors périmètre
Connexion Google ou Apple, double authentification, agences et rôles d'agence (lot 03), vrai prestataire SMS.

## Tests attendus
- Inscription, vérification, connexion, rafraîchissement, déconnexion.
- Rotation du jeton de rafraîchissement et révocation en cas de réutilisation.
- Code expiré, code déjà utilisé, 6e essai refusé.
- Limitation de débit déclenchée.
- Verrouillage après 5 échecs puis déverrouillage après le délai.
- Message identique pour un numéro inconnu et un mauvais mot de passe.
- Le mot de passe et les codes ne sont jamais présents dans les logs (test qui capture les logs).
- Parcours Playwright : inscription puis connexion sur mobile.
- Une personne sans organisation se connecte et arrive sur son espace personnel (vide), sans erreur.

## Critères d'acceptation
- [ ] Un nouvel utilisateur s'inscrit et se connecte en moins de 1 minute (code lu dans les logs en développement).
- [ ] Aucune donnée sensible (mot de passe, code, jeton) en clair en base ou dans les logs.
- [ ] Toutes les routes de l'API hors authentification et `/health` exigent un jeton valide par défaut (guard global, exceptions explicites).
- [ ] Journal des lots mis à jour.

## Instructions de travail
Commence par le schéma des tables et le diagramme des jetons (accès, rafraîchissement, rotation). Attends la validation.
