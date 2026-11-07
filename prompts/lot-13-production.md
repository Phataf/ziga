# Lot 13 — Durcissement et mise en production pour le pilote

## Contexte
Avant de confier l'outil à 3 à 5 agences réelles, il faut qu'il soit déployé, surveillé, sauvegardé, testé en charge et revu sur le plan de la sécurité et des données personnelles. Après ce lot commence la phase 2 (pilote de 12 semaines).

## Prérequis
Lot 12 terminé. Question au porteur : formalités de déclaration à la CIL (voir `docs/DECISIONS.md`).

## Périmètre
1. **Déploiement** (palier 1 du cadrage) :
   - Un serveur (4 vCPU, 8 Go) en conteneurs : web, API, worker BullMQ, PowerSync, PostgreSQL, Redis ; stockage objet externe ; Cloudflare devant la vitrine, les médias et l'API.
   - Environnements `staging` et `production` séparés, avec leurs propres secrets.
   - Déploiement scripté et reproductible (une commande), migrations appliquées automatiquement avant le démarrage, retour arrière documenté.
   - HTTPS partout, en-têtes de sécurité (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`).
2. **Sauvegardes** : copie chiffrée quotidienne de PostgreSQL vers un autre fournisseur que l'hébergeur, conservée 30 jours ; sauvegarde du stockage objet ; **script de restauration testé** sur `staging` et procédure écrite dans `docs/EXPLOITATION.md`.
3. **Supervision** : Sentry (web et API), métriques (temps de réponse, erreurs, file BullMQ, retard de réplication PowerSync, espace disque), sondes de disponibilité externes, alertes vers le téléphone du porteur.
4. **Tests de charge k6** (`infra/k6/`), exécutés sur `staging` :
   - Vitrine : montée à 10 fois le trafic normal estimé en 1 minute ; objectif : aucune erreur, 95 % des réponses de l'origine en moins de 300 ms (hors cache).
   - API : 50 utilisateurs d'agence qui se synchronisent et encaissent en même temps.
   - Rapport des résultats et des goulots dans `docs/EXPLOITATION.md`.
5. **Revue de sécurité** (liste de contrôle dans `docs/SECURITE.md`) : tests d'accès croisé rejoués sur tous les endpoints (test automatisé qui parcourt la liste des routes), injection, téléversement de fichiers malveillants, limitation de débit, rotation des secrets, comptes plateforme protégés, journal d'audit complet sur les actions sensibles.
6. **Données personnelles** (loi 001-2021/AN) : registre des traitements dans `docs/DONNEES-PERSONNELLES.md` (données, finalités, durées de conservation, destinataires) ; page « Confidentialité » et CGU sur la vitrine (textes fournis par le porteur après relecture juridique) ; export des données d'une agence ; procédure de fin de contrat (export, puis conservation 30 jours, puis suppression, sauf données financières conservées selon les obligations légales).
7. **Support** : bouton « Signaler un problème » dans l'application (capture du contexte technique, sans données sensibles), envoyé au back-office.
8. **Mesures du pilote** : tableau de bord back-office par agence (unités importées, part des loyers saisis, reçus émis, jours d'usage par semaine, relevés envoyés), conforme aux critères de la porte 1.

## Hors périmètre
Haute disponibilité multi-serveurs (palier 2), réplique de lecture, application en boutique.

## Tests attendus
- Restauration complète depuis une sauvegarde sur `staging`, vérifiée par un jeu de contrôles (nombre de baux, somme des paiements).
- Test automatisé d'accès croisé sur la totalité des routes.
- Scénarios k6 au vert selon les objectifs.
- En-têtes de sécurité présents (test).

## Critères d'acceptation
- [ ] Une restauration complète prend moins de 1 heure et a été faite au moins une fois.
- [ ] Une panne de l'API déclenche une alerte sur le téléphone du porteur en moins de 5 minutes.
- [ ] Les résultats de charge sont documentés et respectent les objectifs.
- [ ] Le registre des traitements est rédigé.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Commence par la liste de contrôle complète de mise en production, puis traite-la point par point en cochant au fur et à mesure.
