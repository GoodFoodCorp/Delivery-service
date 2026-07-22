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
- **Synchronisation depuis `order-service`** : quand un livreur consulte les
  courses disponibles, les commandes prêtes (`READY_FOR_PICKUP`) sans livraison
  en génèrent une automatiquement, avec points de retrait et de dépôt
- **Accepter une course** — la commande passe alors en `IN_DELIVERY` côté
  `order-service`
- **Marquer la récupération** au restaurant
- **Marquer la livraison** (horodatée) — la commande passe en `DELIVERED`
- **Consulter une livraison** avec sa **dernière position connue**

```
UNASSIGNED → ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED
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
- **ETA** calculée à vol d'oiseau (20 km/h en ville) — pas d'API de cartographie
  payante pour ce POC

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
| GET | `/api/deliveries/available` | `livreur`, `admin` |
| POST | `/api/deliveries/{id}/accept` | `livreur` |
| POST | `/api/deliveries/{id}/pickup` | `livreur` assigné |
| POST | `/api/deliveries/{id}/dropoff` | `livreur` assigné |
| GET | `/api/deliveries/{id}` (+ dernière position) | propriétaire, franchisé, livreur, `admin` |
| WS | `/tracking` | `livreur` (émission), client/franchisé/`admin` (écoute) |
| GET | `/healthz`, `/readyz` | public (sondes) |

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
