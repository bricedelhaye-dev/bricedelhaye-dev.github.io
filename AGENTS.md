# Le Quai joue — carte des agents

Lire dans cet ordre :
1. `docs/core/INVARIANTS.md`
2. `docs/state/CURRENT_STATE.md`
3. `docs/plans/active/PORTES_ACTUELLES.md`
4. `docs/plans/active/PLAN_MATURATION_TOTALE.md`
5. `docs/quality/PREFLIGHT.md`

Règles :
- respecter le statut courant ;
- ne jamais franchir une porte fermée ;
- ne jamais traiter une règle historique comme active sans confirmation ;
- ne jamais pousser une refonte directement sur `main` ;
- utiliser une branche isolée ;
- ne jamais contourner un contrôle en échec ;
- appliquer `POSTFLIGHT.md` après modification ;
- en cas de dérive appliquer `RETOUR_USINE.md`.

État actuel : STOP AVANT AUDIT.
