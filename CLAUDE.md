# Instructions Claude — Le Quai joue

Respecter `AGENTS.md` dans son intégralité.

- Référence immuable : v13,
  `623a577afb374b158d972623f517716c56e87efe`, branche `v13-stable`.
- Ne jamais modifier, déplacer, supprimer ou forcer `v13-stable`.
- Ne pas réintroduire les anciens prototypes v14 complexes.
- Conserver la direction : `Maintenant` / `Plus tard aujourd’hui` /
  `Vous voulez participer ?`.
- Conserver les actions : `Je suis au quai` / `Je pense venir plus tard` /
  `J’ai une question pour Brice`.
- Ne pas ajouter `Signaler quelque chose`.
- Sans demande explicite, ne modifier aucun contenu visible ni fichier
  fonctionnel du site.
- Garder le site statique, simple et compatible avec GitHub Pages.
- Avant livraison, exécuter `pnpm install --frozen-lockfile`, puis
  `pnpm run check`, et examiner le diff final.
- Ne jamais contourner un contrôle en échec ou déployer malgré un échec.

## Publication et déploiement

Pour toute demande destinée à être publiée :

1. Partir de la dernière version de `main` et créer une branche
   `claude/<description-courte>`.
2. Ne jamais pousser directement sur `main` ou `v13-stable`.
3. Effectuer uniquement les modifications demandées.
4. Exécuter `pnpm install --frozen-lockfile`, puis `pnpm run check`.
5. Vérifier le diff final et ouvrir une pull request vers `main`.
6. Activer la fusion automatique seulement si tous les contrôles réussissent et
   si le diff reste dans le périmètre demandé.
7. Laisser le workflow `Quality gates and GitHub Pages` déployer
   automatiquement après la fusion dans `main`.

Ne jamais lancer ou forcer un déploiement séparé pour contourner les contrôles.
