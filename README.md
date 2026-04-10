# Single-Tenant Conversion + User Invitation & Access Control

## What Changed

### Architecture

| Before (Multi-Tenant) | After (Single-Tenant) |
|---|---|
| Main DB stores `clients` table with encrypted DB credentials | No main DB — one `DATABASE_URL` points directly to the client DB |
| `getClientConnection(accountId)` looked up credentials at runtime | `db` is a single shared Knex instance |
| `Key` cookie carried `accountId` on every request | JWT carries `userId`, `email`, `name`, `role` only |
| API key validated against `clients` table in main DB | API key validated against `APP_API_KEY` env variable |

---

## New Files (Backend)

| File | Purpose |
|---|---|
| `src/config/database.js` | Single `db` knex instance via `DATABASE_URL` |
| `src/middlewares/jwt.middleware.js` | JWT verify + `requireAdmin` guard |
| `src/middlewares/apiKey.middleware.js` | Static env-var API key check |
| `src/middlewares/permission.middleware.js` | `loadUserPermissions`, `checkModuleAccess`, `subsidiaryFilter` |
| `src/migrations/..._create_auth_and_permission_tables.js` | Creates `app_users`, `user_permissions`, `invitation_tokens` |
| `src/services/user.service.js` | Invitation, permission CRUD, subsidiary lookup |
| `src/controllers/user.controller.js` | HTTP handlers for all user/invite endpoints |
| `src/routes/user.routes.js` | Routes for `/api/database/users/...` |
| `src/utils/mailer.js` | Nodemailer-based invitation email sender |
| `setup.js` | One-time migration + seed Admin script |

## Modified Files (Backend)

| File | What Changed |
|---|---|
| `src/services/database.service.js` | Removed `getClientConnection(accountId)` — uses `db` directly |
| `src/services/getdata.services.js` | Removed `accountId` params; accepts `subsidiaryFn` for filtering |
| `src/controllers/database.controller.js` | Login now checks `app_users`; all handlers use `req.permissions` |
| `src/routes/database.routes.js` | Permission middleware added to all protected routes |
| `src/app.js` | User routes registered; no more `Key` cookie logic |
| `knexfile.js` | Removed master DB config; single `DATABASE_URL` |

## New Files (Frontend)

| File | Purpose |
|---|---|
| `app/auth/accept-invite/page.js` | Public page — invited user sets name + password |

## Modified Files (Frontend)

| File | What Changed |
|---|---|
| `src/contexts/AuthContext.js` | `canAccessModule()`, `canAccessSubsidiary()` helpers added; no `Key` cookie |
| `src/services/authService.js` | New `userService` with invite/permission API calls |
| `src/services/api.js` | Added `apiPut` and `apiDelete` helpers |
| `app/user-management/page.js` | 3-step invite modal (email→subsidiaries→modules); edit permissions with tabs |

---

## Database Tables Created by Migration

### `app_users`
Stores all users who can log into this application.

```
id            serial PK
name          varchar
email         varchar UNIQUE NOT NULL
password_hash varchar        (null until invite accepted)
role          varchar        Admin | User | Viewer
status        varchar        Active | Pending | Inactive
invited_by    FK → app_users.id
```

### `user_permissions`
One row per non-admin user. Controls what they can see.

```
id                  serial PK
user_id             FK → app_users.id UNIQUE
subsidiary_access   jsonb    ["Sub A", "Sub B"]
module_access       jsonb    ["customers", "invoices"]
```

### `invitation_tokens`
Disposable tokens emailed to invitees.

```
id                  serial PK
token               varchar(128) UNIQUE
email               varchar
role                varchar
subsidiary_access   jsonb
module_access       jsonb
invited_by          FK → app_users.id
used                boolean DEFAULT false
expires_at          timestamp
```

---

## Setup Instructions

### 1. Install new backend dependencies

```bash
npm install bcryptjs nodemailer
```

### 2. Update your `.env`

```
# Remove all old DB_HOST / DB_USER / DB_PASSWORD / DB_NAME vars.
# Add:
DATABASE_URL=postgresql://user:pass@host:5432/your_client_db
JWT_SECRET=a_long_random_string
APP_API_KEY=another_random_string_for_netsuite_webhooks

# For invitation emails:
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@example.com
SMTP_PASS=your_app_password
FRONTEND_URL=https://your-app.com
```

### 3. Run one-time setup

```bash
ADMIN_EMAIL=admin@yourcompany.com \
ADMIN_PASSWORD=SecurePass123 \
ADMIN_NAME="Site Admin" \
node setup.js
```

This runs migrations and creates the first Admin user.

### 4. Frontend `.env.local`

```
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

---

## Access Control Flow

### Login
```
POST /api/database/auth/login  { email, password }
→ Checks app_users → bcrypt compare → JWT cookie set
→ Response includes subsidiaryAccess[], moduleAccess[]
```

### Every Protected API Request
```
Request → verifyToken → loadUserPermissions → subsidiaryFilter
                                            ↓
                                   req.permissions = {
                                     isAdmin: false,
                                     subsidiaryAccess: ["Sub A"],
                                     moduleAccess: ["customers"]
                                   }
                                   req.applySubsidiaryFilter = fn
```

### Table Data Query (automatic subsidiary filter)
```js
// In getdata.services.js:
let query = db('customers');
if (subsidiaryFn) query = subsidiaryFn(query, 'customers');
// Injects: WHERE subsidiary IN ('Sub A')
```

### Module Guard (per route)
```
GET /api/database/tables/invoices/rows
→ checkModuleAccess middleware
→ if 'invoices' not in user's moduleAccess → 403 Forbidden
```

### Admin Bypass
Admin role skips ALL restrictions — no subsidiary filter, no module check.

---

## Invitation Flow

```
Admin sends invite
  → POST /api/database/users/invite
  → invitation_tokens row created (72hr TTL)
  → Email sent with link: /auth/accept-invite?token=xxx

Invited user clicks link
  → GET /api/database/users/invite/verify?token=xxx  (validates token)
  → User fills name + password
  → POST /api/database/users/accept-invite
  → app_users row created (status: Active)
  → user_permissions row created
  → token marked as used
```

---

## API Reference (new endpoints)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/database/auth/login` | Public | Login |
| `POST` | `/api/database/auth/logout` | Public | Logout |
| `GET` | `/api/database/auth/check` | JWT | Check session |
| `GET` | `/api/database/auth/me` | JWT | Get profile |
| `GET` | `/api/database/users` | Admin | List users |
| `GET` | `/api/database/users/:id` | Admin | Get user |
| `POST` | `/api/database/users/invite` | Admin | Send invitation |
| `GET` | `/api/database/users/invite/verify` | Public | Verify invite token |
| `POST` | `/api/database/users/accept-invite` | Public | Accept invite + set password |
| `PUT` | `/api/database/users/:id/permissions` | Admin | Update subsidiary + module access |
| `DELETE` | `/api/database/users/:id` | Admin | Remove user |
| `GET` | `/api/database/users/subsidiaries` | JWT | Get subsidiary list |
| `GET` | `/api/database/users/modules` | Admin | Get all table names |
