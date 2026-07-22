# Delivery Service

Microservice NestJS de gestion des livraisons et du **suivi GPS temps réel**
(Socket.IO) pour Good Food 3.0. Base MongoDB dédiée.

## Architecture

```
src/
├── main.ts                       # pino JSON, ValidationPipe, Swagger /docs
├── app.module.ts
├── common/
│   ├── auth.util.ts              # Actor, verifyToken (HS256 partagé), extractToken
│   ├── errors.ts                 # Erreurs métier typées (DomainError)
│   ├── decorators/               # @Roles, @CurrentActor
│   ├── filters/                  # GlobalExceptionFilter (erreurs → HTTP)
│   ├── guards/                   # JwtAuthGuard, RolesGuard
│   └── interceptors/             # RequestIdInterceptor (X-Request-ID)
├── core/
│   ├── config/                   # ConfigModule + configuration typée
│   └── db/                       # DbModule (connexion Mongo), DbService (readiness)
└── modules/
    ├── delivery/
    │   ├── delivery.controller.ts   # Routes HTTP fines — zéro logique métier
    │   ├── delivery.gateway.ts      # WS /tracking — authentifie, valide, délègue
    │   ├── delivery.service.ts      # Toute la logique métier / orchestration
    │   ├── delivery.repository.ts   # Interface + impl. Mongoose (mockable)
    │   ├── delivery.module.ts
    │   ├── orders.client.ts         # Client REST vers order-service (token forwardé)
    │   ├── geo.ts                   # Coordonnées + ETA (POC, pas d'API payante)
    │   ├── entities/                # Schémas Mongoose : Delivery, PositionUpdate (TTL 24 h)
    │   └── dto/                     # class-validator (UpdatePositionDto, SubscribeDto)
    └── health/                      # /healthz, /readyz
```

## Cycle de vie d'une livraison

`UNASSIGNED → ASSIGNED (accept) → PICKED_UP (pickup) → IN_TRANSIT (1ʳᵉ position GPS) → DELIVERED (dropoff, horodaté)`

**Création** : quand un livreur consulte `GET /api/deliveries/available`, le
service synchronise depuis `GET /api/orders/ready-for-delivery` (order-service)
en **réutilisant le JWT du livreur** — pas de compte de service. Les commandes
prêtes sans livraison deviennent des livraisons `UNASSIGNED`.

**Effets de bord** : accept → la commande passe `IN_DELIVERY` côté
order-service ; dropoff → `DELIVERED` (best-effort, loggé si indisponible).

## Temps réel (Socket.IO, namespace `/tracking`)

```js
const socket = io('http://localhost:8084/tracking', { auth: { token: accessToken } });
// Livreur : émet sa position (ack en retour)
socket.emit('position:update', { deliveryId, lat, lng }, (ack) => {});
// Client : s'abonne à SA livraison puis reçoit les broadcasts
socket.emit('delivery:subscribe', { deliveryId }, (ack) => {});
socket.on('position:broadcast', (pos) => { /* { lat, lng, timestamp, status } */ });
```

Contrôle d'accès : seul le livreur assigné peut émettre ; seuls le client
propriétaire, le manager du restaurant, le livreur ou l'admin peuvent suivre.

## Lancement

```bash
docker network create microservices-net   # une fois
cp .env.example .env                      # MONGO_PASSWORD + JWT_SECRET (= auth-service)
docker compose up -d --build
```

## Variables d'environnement

| Variable | Requis | Description |
|---|---|---|
| `MONGO_USER` / `MONGO_PASSWORD` | oui | Credentials du Mongo dédié (port hôte 27017) |
| `MONGODB_URI` | hors docker | Le compose la construit pour le conteneur |
| `JWT_SECRET` | oui | Secret HS256 **identique au auth-service** |
| `ORDER_SERVICE_URL` | non | Défaut `http://order-service:8082` |
| `PORT` / `LOG_LEVEL` | non | 8084 / info |

## Endpoints (port 8084)

Swagger : `GET /docs`

| Méthode | Route | Rôles |
|---|---|---|
| GET | `/api/deliveries/available` | livreur, admin |
| POST | `/api/deliveries/{id}/accept` | livreur |
| POST | `/api/deliveries/{id}/pickup` | livreur assigné |
| POST | `/api/deliveries/{id}/dropoff` | livreur assigné |
| GET | `/api/deliveries/{id}` (+ dernière position) | client propriétaire, manager du resto, livreur, admin |
| WS | `/tracking` | livreur (émission), client/manager/admin (écoute) |
| GET | `/healthz`, `/readyz` | public (probes K8s) |

## Tests & lint

```bash
npm test              # 14 tests Jest (service : 95% de couverture)
npm run lint          # ESLint (TS strict) — npx prettier --check aussi dispo
```

Le repository est injecté par interface (`DELIVERY_REPOSITORY`) : les tests du
service utilisent un fake en mémoire, sans MongoDB.
