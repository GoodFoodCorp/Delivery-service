# Delivery Service

Microservice **NestJS** gérant les **livraisons** et le **suivi GPS en temps réel**
des livreurs.

| | |
|---|---|
| **Langage / techno** | TypeScript, NestJS 10, Mongoose, Socket.IO, class-validator, nestjs-pino, Swagger |
| **Base de données** | MongoDB (port hôte `27017`) |
| **Port HTTP / WebSocket** | `8084` |
| **Documentation API** | http://localhost:8084/docs |

---

## Architecture — structure modulaire NestJS

```
src/
├── main.ts                  # Bootstrap, ValidationPipe, filtre global, Swagger
├── app.module.ts
├── common/
│   ├── auth.util.ts         # Actor, vérification du JWT (HS256 partagé)
│   ├── errors.ts            # Erreurs métier typées (DomainError)
│   ├── decorators/          # @Roles, @CurrentActor
│   ├── filters/             # GlobalExceptionFilter (erreurs métier → HTTP)
│   ├── guards/              # JwtAuthGuard, RolesGuard
│   └── interceptors/        # RequestIdInterceptor (X-Request-ID)
├── core/
│   ├── config/              # ConfigModule + configuration typée
│   └── db/                  # DbModule (connexion Mongo), DbService (readiness)
└── modules/
    ├── delivery/
    │   ├── delivery.controller.ts   # Routes HTTP — zéro logique métier
    │   ├── delivery.gateway.ts      # WebSocket /tracking — authentifie et délègue
    │   ├── delivery.service.ts      # Toutes les règles métier
    │   ├── delivery.repository.ts   # Interface + implémentation Mongoose
    │   ├── delivery.module.ts
    │   ├── orders.client.ts         # Client REST vers order-service
    │   ├── geo.ts                   # Coordonnées et ETA (sans API payante)
    │   ├── entities/                # Schémas Delivery, PositionUpdate (TTL 24 h)
    │   └── dto/                     # UpdatePositionDto, SubscribeDto
    └── health/                      # /healthz, /readyz
```

**Règle** : le contrôleur **et la gateway WebSocket** ne font qu'authentifier,
valider et déléguer. Toutes les règles vivent dans `delivery.service.ts`. Le
repository est injecté par interface, ce qui permet de tester sans MongoDB.

---

## Fonctionnalités

### Cycle d'une livraison
- **Création sur événement** `order.ready_for_pickup` (RabbitMQ) : retrait =
  adresse et position **réelles** du restaurant (`franchise-service`, en cache),
  dépôt = position **géocodée** de la commande ; une estimation est signalée
  (`locationApproximate`). Les commandes à emporter (`PICKUP`) n'en ont pas.
- **Filet de sécurité** : un job de réconciliation (une seule instance, bail
  Mongo) crée les livraisons dont l'événement aurait été perdu — les livreurs
  ne déclenchent plus de synchronisation à chaque rafraîchissement.
- **Courses disponibles** sans donnée client (zone de dépôt arrondie,
  distance, rémunération, pourboire), triées par proximité avec
  `?lat=&lng=&radiusKm=` (index 2dsphere).
- **Accepter une course** : écriture conditionnelle (un seul gagnant) puis
  assignation côté `order-service` (API interne), annulée si elle échoue. La
  commande n'avance pas : le livreur peut partir pendant la préparation.
- **Libérer une course** avant le retrait.
- **Retrait** : la commande passe d'abord en `IN_DELIVERY` (refusé tant que la
  cuisine n'a pas marqué `READY_FOR_PICKUP`), puis la livraison.
- **Remise** : le livreur saisit le **code à 4 chiffres** que seul le client
  voit (preuve de livraison, blocage après 5 erreurs).
- **Annulation** : `order.cancelled` annule la livraison et prévient le
  livreur (`delivery:cancelled`).
- **Notation** par le client (1 à 5) ; moyenne visible par le livreur.
- **Gains** : sommes calculées en base, pourboires inclus ; IBAN chiffrés
  (AES-256-GCM).

```
UNASSIGNED → ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED
     ↑___________| (release)          (order.cancelled → CANCELLED)
```

### Suivi temps réel (WebSocket, namespace `/tracking`)

```js
const socket = io('http://localhost:8084/tracking', { auth: { token: accessToken } });

// Livreur : émettre sa position
socket.emit('position:update', { deliveryId, lat, lng }, (ack) => {});

// Client : s'abonner à SA livraison, puis recevoir les positions
socket.emit('delivery:subscribe', { deliveryId }, (ack) => {});
socket.on('position:broadcast', (pos) => { /* { lat, lng, timestamp, status } */ });
```

- La première position reçue fait passer la livraison en `IN_TRANSIT`
- Historique des positions **purgé automatiquement après 24 h** (index TTL Mongo)
- **ETA** calculée à vol d'oiseau (20 km/h en ville)
- Positions enregistrées au plus toutes les 3 s (le flux temps réel reçoit tout)
- Avec `REDIS_URL`, les salles Socket.IO sont partagées entre réplicas
  (adapter Redis, transport WebSocket uniquement)
- Nouvelles courses poussées (Expo, lots de 100) aux livreurs disponibles à
  moins de `PUSH_RADIUS_KM` du restaurant

### Cloisonnement
- Seul le **livreur assigné** peut marquer la récupération, la livraison ou
  émettre des positions
- Une course déjà acceptée ne peut pas l'être une seconde fois (`409`)
- Peuvent suivre la course : le **client propriétaire**, le **franchisé du
  restaurant**, le **livreur** et le **siège**

---

## Endpoints

| Méthode | Route | Accès |
|---|---|---|
| GET | `/api/deliveries/available?lat=&lng=&radiusKm=` | `livreur`, `admin` |
| POST | `/api/deliveries/{id}/accept` | `livreur` |
| POST | `/api/deliveries/{id}/release` | `livreur` assigné (avant retrait) |
| POST | `/api/deliveries/{id}/pickup` | `livreur` assigné |
| POST | `/api/deliveries/{id}/dropoff` | `livreur` assigné — `{code}` |
| POST | `/api/deliveries/{id}/rating` | client — `{rating, comment}` |
| GET | `/api/deliveries/{id}` (+ dernière position, code pour le client) | client, franchisé, livreur assigné, `admin` |
| PUT | `/api/courier-profile/location` | `livreur` — `{lat, lng}` |
| WS | `/tracking` | `livreur` (émission), client/franchisé/`admin` (écoute) |
| GET | `/healthz`, `/readyz` | public (sondes) |

---

## Dépendances

> **Légende** — 🔴 indispensable (le service ne démarre pas ou ne sert à rien) ·
> 🟠 nécessaire à une fonctionnalité (le reste continue de marcher) ·
> 🟡 optionnelle (dégradation silencieuse, journalisée)

| Dépendance | Type | Conséquence si absente |
|---|---|---|
| **MongoDB** (`delivery-db`) | 🔴 | Le service ne démarre pas |
| **order-service** | 🟠 | La **synchronisation des courses échoue** : aucune nouvelle livraison n'est créée à partir des commandes prêtes (l'erreur est journalisée, la liste des livraisons existantes reste servie). Les changements de statut (`IN_DELIVERY`, `DELIVERED`) ne remontent plus aux commandes — l'échec est journalisé sans casser la livraison. |
| **auth-service** | 🟠 | Aucun appel réseau, mais toutes les routes et le WebSocket exigent un jeton valide |

### Qui dépend de ce service

| Service | Type | Conséquence si `delivery-service` est arrêté |
|---|---|---|
| Future **application mobile livreur** | 🔴 | Inutilisable |
| `web-app` | 🟢 | Aucun impact aujourd'hui : le front n'expose pas encore d'écran de livraison |

Aucun autre service ne l'appelle.

---

## Lancement

```bash
docker network create microservices-net   # une seule fois, partagé
cp .env.example .env                      # renseigner MONGO_PASSWORD et JWT_SECRET
docker compose up -d --build
```

⚠️ `JWT_SECRET` doit être **identique** à celui de `auth-service`.
`order-service` doit tourner pour la synchronisation des courses.

### Variables d'environnement

| Variable | Requis | Description |
|---|---|---|
| `PORT` | non (8084) | Port HTTP/WebSocket |
| `MONGO_USER` / `MONGO_PASSWORD` | oui | Credentials du MongoDB dédié |
| `MONGODB_URI` | oui | Le compose la construit pour le conteneur |
| `JWT_SECRET` | oui | Secret HS256 partagé avec `auth-service` |
| `ORDER_SERVICE_URL` | non | Défaut `http://order-service:8082` |
| `LOG_LEVEL` | non (info) | Niveau de journalisation |

---

## Tests

```bash
npm test              # 14 tests Jest (service couvert à ~95 %)
npm run lint          # ESLint TypeScript strict
npx tsc --noEmit      # vérification des types
```

Les tests utilisent un faux repository en mémoire — aucun MongoDB requis.

> ⚠️ **Aucune CI n'est configurée sur ce projet** — les tests doivent être lancés
> manuellement.
