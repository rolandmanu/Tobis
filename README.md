# TOBIS — notification WhatsApp anonyme

Cette version est pensée pour un usage anonyme : le passager donne simplement son numéro WhatsApp et la ligne souhaitée. Le chauffeur partage sa position GPS, et le backend (Firebase + Cloud Functions + WhatsApp Business) envoie des alertes toutes les 2 minutes ou plus souvent à l’approche.

## Ce que l’application fait dans le navigateur

- permet d’ouvrir une PWA installable
- affiche les trajets actifs déjà publiés dans Firebase
- permet au chauffeur de démarrer un trajet avec GPS
- publie la localisation du chauffeur dans Firestore si Firebase est configuré
- permet au passager de s’inscrire via un numéro WhatsApp (sans compte email)

## Ce que le navigateur ne peut pas faire seul

Le frontend ne peut pas envoyer de messages WhatsApp automatiquement :

- WhatsApp Business nécessite un backend officiel
- les jetons et secrets du fournisseur ne doivent pas être exposés dans le navigateur
- les messages automatiques exigent les règles, les consentements et la conformité de Meta

Le navigateur peut uniquement déclencher la publication de coordonnées et enregistrer la demande d’abonnement.

## Architecture recommandée

1. Chauffeur : publie sa position GPS dans Firestore (`liveTrips/{id}`)
2. Backend Cloud Functions : surveille les trajets actifs; calcule ETA et approche d’arrêt
3. WhatsApp Business API : envoie des messages au passager toutes les 2 minutes,
   ou plus souvent quand le bus approche
4. Firebase Firestore : conserve les abonnements passagers et les positions actives

## Firebase base

1. Créez un projet Firebase
2. Activez Firestore
3. Remplacez les valeurs de `firebase-config.js`
4. Déployez la configuration hosting et les règles :

```sh
firebase deploy --only hosting,firestore:rules
```

## Modèle d’abonnement passager

Un abonnement minimal ressemble à :

```json
{
  "phone": "+212612345678",
  "line": "Ligne A",
  "stop": "Avenue Mohammed V",
  "status": "active",
  "createdAt": "2026-11-04T10:00:00Z"
}
```

## Backend WhatsApp (obligatoire)

L’API WhatsApp Business doit tourner côté serveur. Exemple de logique :

- chaque 2 minutes : envoyer un message si le trajet est actif
- si ETA < 3 minutes : augmenter la fréquence ou envoyer un message plus urgent
- si trajet terminé : arrêter les messages

Le backend calcule la distance totale et l’ETA à partir des arrêts connus et des positions GPS.

## Limites importantes

- une PWA en navigateur ne peut pas fonctionner en arrière-plan fiable sur tous les téléphones
- le chauffeur doit rester connecté à Internet pour mettre à jour sa position
- le passager doit avoir un accès à WhatsApp pour recevoir les notifications
- les règles et le consentement WhatsApp doivent être vérifiés avant mise en service
- le message individuel ou en masse peut être limité selon le plan de l’opérateur et les règles Meta

## Vérification rapide

1. Connectez Firebase et remplissez le fichier `firebase-config.js`
2. Lancez le site en HTTPS
3. Démarrez un trajet de démonstration
4. Configurez un abonnement passager avec un numéro de test
5. Vérifiez l’écriture dans Firestore
6. Le backend WhatsApp Business doit alors envoyer les messages automatiques selon la logique ETA

La version de cette interface n’envoie pas directement des messages WhatsApp ; elle prépare la collecte des positions et les abonnements nécessaires au backend Cloud Functions.
