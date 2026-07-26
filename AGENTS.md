# Le Quai joue — règles du projet

Ces règles s’appliquent à tout le dépôt.

## Référence stable

- La version stable de référence est la v13 au commit
  `623a577afb374b158d972623f517716c56e87efe`.
- La branche `v13-stable` doit toujours pointer exactement vers ce commit.
- Ne jamais modifier, rebaser, déplacer, supprimer ni forcer la mise à jour de
  `v13-stable`.
- Ne jamais réintroduire les anciens prototypes v14 complexes.

## Direction éditoriale et fonctionnelle

Conserver une expérience simple, directe et immédiatement compréhensible autour
des trois moments suivants :

1. `Maintenant`
2. `Plus tard aujourd’hui`
3. `Vous voulez participer ?`

Conserver les trois actions suivantes :

- `Je suis au quai`
- `Je pense venir plus tard`
- `J’ai une question pour Brice`

Ne pas ajouter l’action ou le libellé `Signaler quelque chose`.

## Périmètre des changements

- Ne modifier le contenu visible, le comportement, les données, la navigation,
  le SEO ou les médias du site que si la demande le prévoit explicitement.
- Pour une tâche purement technique, ne modifier aucun fichier fonctionnel du
  site : fichiers HTML, JavaScript applicatif, images, icônes, `robots.txt` et
  `sitemap.xml`.
- Préférer une modification petite, ciblée et réversible.
- Ne pas ajouter de framework, de système de build ou de dépendance applicative
  sans nécessité explicite.
- Le site reste un site statique déployable par GitHub Pages.

## Méthode de travail

1. Lire la demande et vérifier `git status`, la branche et le diff existant.
2. Préserver les changements de l’utilisateur qui ne font pas partie de la
   demande.
3. Vérifier avant livraison :
   - `pnpm install --frozen-lockfile`
   - `pnpm run check`
4. Inspecter le diff final et confirmer qu’aucun fichier hors périmètre n’a été
   modifié.
5. Ne jamais contourner un contrôle en échec. Corriger la cause ou expliquer le
   blocage.

## Déploiement

- `main` est la seule branche déployée.
- Le déploiement GitHub Pages ne doit démarrer qu’après la réussite de tous les
  contrôles HTML, JavaScript, liens internes et tests présents.
- Une pull request ne doit pas être fusionnée automatiquement tant que les
  contrôles ne sont pas tous réussis et que le diff n’a pas été vérifié.
