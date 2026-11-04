# TOBIS PWA + Firebase — installation et mise en service

Cette version est une base PWA fonctionnelle : navigation, installation, cache de l’interface, connexion chauffeur Firebase Authentication, publication GPS et lecture en direct des trajets avec Cloud Firestore. Elle ne contient pas les horaires, arrêts ni positions réelles d’un opérateur. Tant que le projet Firebase et les comptes de chauffeur ne sont pas configurés, elle reste en mode démonstration.

## 1. Créer/configurer Firebase

1. Créez un projet dans Firebase Console et ajoutez une application Web.
2. Activez **Authentication → Sign-in method → Email/Password**.
3. Créez **Cloud Firestore** en mode production.
4. Copiez les paramètres de l’application Web dans `firebase-config.js` en remplaçant toutes les valeurs `REPLACE_...`. Ces paramètres web ne sont pas des clés secrètes.
5. Installez Firebase CLI, connectez-vous (`firebase login`), puis associez le projet (`firebase use --add`).
6. Déployez les règles fournies : `firebase deploy --only firestore:rules`.
7. Créez les comptes chauffeurs dans Firebase Authentication. Pour chacun, créez dans Firestore un document `users/{UID}` (UID de l’authentification) avec le champ `{ "role": "driver" }`. Ne donnez jamais aux utilisateurs le droit de modifier leur propre rôle.
8. Ajoutez les documents de lignes dans `routes/` depuis un outil d’administration fiable. Aucun client ne peut les écrire avec les règles incluses.

## 2. Déployer l’application

Dans la racine du dépôt, après avoir sélectionné le bon projet Firebase :

```sh
firebase deploy --only hosting,firestore:rules
```

La géolocalisation nécessite HTTPS (Firebase Hosting le fournit). La PWA peut être installée depuis un navigateur compatible après un premier chargement en ligne.

## Données de trajet

Chaque trajet publié est un document `liveTrips/{id}` contenant `driverUid`, `city`, `line`, `status`, `location`, `startedAt` et `updatedAt`. La position est remplacée à chaque mise à jour GPS; l’historique détaillé n’est pas conservé. Les trajets terminés ont `status: ended` et ne sont plus visibles dans la liste publique.

## Limites et sécurité à traiter avant une exploitation réelle

- Les chauffeurs publient uniquement quand la page reste ouverte. Les navigateurs mobiles suspendent souvent le GPS en arrière-plan; cette PWA ne garantit pas un suivi permanent.
- Les règles protègent l’accès en écriture mais laissent lire les trajets actifs publiés. Décidez si la position précise peut être publique ou si une authentification/autorisation passager est requise.
- Ajoutez une politique de confidentialité, le consentement, des délais de conservation et un processus de suppression, conformément aux exigences locales.
- Le cache PWA ne met pas en cache les SDK Firebase distants ni les données Firestore du serveur. Firestore utilise son cache local pour les données déjà lues; l’envoi GPS exige le réseau.
- Restrignez les API keys par domaine et configurez les quotas/alertes de facturation. Une Firebase API key côté web ne remplace jamais les règles de sécurité.
- Publiez seulement les lignes et horaires confirmés par l’opérateur. Le projet ne fournit pas de vrais horaires ni un fond cartographique.

## Vérification

Ouvrez le site sur HTTPS, vérifiez l’onglet Application/Service Workers, testez la liste vide, puis connectez un compte chauffeur autorisé et démarrez un trajet. Contrôlez côté console Firebase qu’un document `liveTrips` apparaît et que sa position évolue. Testez également le refus GPS et l’absence de réseau avant tout pilote.
