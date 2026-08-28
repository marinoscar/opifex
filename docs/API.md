# API Reference

## Base URL

- **Development**: http://localhost:3535/api
- **Production**: https://yourdomain.com/api

## Authentication

All endpoints require JWT Bearer token authentication unless explicitly marked as **Public**.

**Authorization Header:**

```
Authorization: Bearer <access_token>
```

Access tokens are short-lived (15 minutes by default). Use the refresh token flow to obtain new access tokens.

## Response Format

### Success Response

```json
{
  "data": <response_data>,
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest"
}
```

For validation errors:

```json
{
  "statusCode": 400,
  "message": ["Field validation error 1", "Field validation error 2"],
  "error": "BadRequest"
}
```

## Pagination

Endpoints returning lists support pagination with the following query parameters:

| Parameter  | Type   | Default | Max | Description             |
| ---------- | ------ | ------- | --- | ----------------------- |
| `page`     | number | 1       | -   | Page number (1-indexed) |
| `pageSize` | number | 20      | 100 | Items per page          |

**Paginated Response Format:**

```json
{
  "data": [...],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

---

## Endpoints

### Authentication

#### GET /auth/providers

**Public endpoint** - List enabled OAuth providers.

**Response:**

```json
{
  "data": {
    "providers": [
      {
        "name": "google",
        "enabled": true
      }
    ]
  }
}
```

---

#### GET /auth/google

**Public endpoint** - Initiate Google OAuth flow. Redirects to Google consent screen.

**Response:** HTTP 302 redirect to Google

---

#### GET /auth/google/callback

**Public endpoint** - OAuth callback handler (called by Google).

**Query Parameters:**

- `code` (string) - Authorization code from Google
- `state` (string, optional) - CSRF protection state

**Response:** HTTP 302 redirect to frontend with access token in query parameter

- Sets HttpOnly refresh token cookie
- Redirects to `/auth/callback?accessToken=<token>`

**Error Cases:**

- Email not in allowlist → Redirects to `/auth/error?error=not_authorized`
- OAuth failure → Redirects to `/auth/error?error=oauth_failed`

---

#### GET /auth/me

**Requires Authentication** - Get current user profile.

**Response:**

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    }
  ],
  "permissions": ["users:read", "users:write", "system_settings:read", ...]
}
```

---

#### POST /auth/refresh

**Public endpoint** - Refresh access token using refresh token cookie.

**Request:** No body required (uses HttpOnly cookie)

**Response:**

```json
{
  "accessToken": "new_jwt_access_token",
  "expiresIn": 900
}
```

Sets new refresh token in HttpOnly cookie (token rotation).

**Error Cases:**

- 401 Unauthorized - Missing or invalid refresh token
- 403 Forbidden - User is disabled

---

#### POST /auth/logout

**Requires Authentication** - Logout and revoke refresh token.

**Request:** No body required

**Response:** HTTP 204 No Content

- Clears refresh token cookie
- Revokes refresh token in database

---

#### POST /auth/logout-all

**Requires Authentication** - Logout from all devices and revoke all refresh tokens.

**Request:** No body required

**Response:** HTTP 204 No Content

- Clears refresh token cookie
- Revokes ALL refresh tokens for the current user across all devices

**Use Case:** Security feature to force re-authentication on all sessions (e.g., after password change or suspected compromise).

---

### Device Authorization (RFC 8628)

The Device Authorization Flow enables input-constrained devices (CLI tools, IoT devices, Smart TVs) to obtain user authorization. See [DEVICE-AUTH.md](DEVICE-AUTH.md) for comprehensive guide and integration examples.

#### POST /auth/device/code

**Public endpoint** - Generate device code pair to initiate device authorization flow.

**Request Body:**

```json
{
  "clientInfo": {
    "name": "My CLI Tool",
    "version": "1.0.0",
    "platform": "linux"
  }
}
```

**Fields:**

| Field                 | Type   | Required | Description                           |
| --------------------- | ------ | -------- | ------------------------------------- |
| `clientInfo`          | object | No       | Optional metadata about client device |
| `clientInfo.name`     | string | No       | Application name                      |
| `clientInfo.version`  | string | No       | Application version                   |
| `clientInfo.platform` | string | No       | Platform identifier                   |

**Response:**

```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/device",
    "verificationUriComplete": "http://localhost:3535/device?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**Response Fields:**

| Field                     | Type   | Description                                           |
| ------------------------- | ------ | ----------------------------------------------------- |
| `deviceCode`              | string | Opaque code for device polling (keep secret)          |
| `userCode`                | string | Human-readable code for user entry (XXXX-XXXX format) |
| `verificationUri`         | string | URL where user should authorize                       |
| `verificationUriComplete` | string | URL with user code pre-filled                         |
| `expiresIn`               | number | Code lifetime in seconds (default: 900)               |
| `interval`                | number | Minimum polling interval in seconds (default: 5)      |

---

#### POST /auth/device/token

**Public endpoint** - Poll for authorization status and obtain tokens when approved.

**Request Body:**

```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (200 OK - Authorized):**

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

**Error Responses (400 Bad Request):**

While authorization is pending:

```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

Device polling too frequently:

```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

Code has expired:

```json
{
  "error": "expired_token",
  "error_description": "The device code has expired"
}
```

User denied authorization:

```json
{
  "error": "access_denied",
  "error_description": "User denied the authorization request"
}
```

**Error Response (401 Unauthorized):**

Invalid device code:

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid device code"
}
```

**Usage:**

1. Device requests code from `/auth/device/code`
2. Device displays `userCode` and `verificationUri` to user
3. Device polls this endpoint every `interval` seconds
4. User visits verification page and approves device
5. Polling returns tokens when approved

---

#### GET /auth/device/activate

**Requires Authentication** - Get activation page information and validate user code.

**Query Parameters:**

| Parameter | Type   | Required | Description                        |
| --------- | ------ | -------- | ---------------------------------- |
| `code`    | string | No       | User verification code to validate |

**Request (No Code):**

```http
GET /auth/device/activate
Authorization: Bearer <token>
```

**Response (No Code):**

```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device"
  }
}
```

**Request (With Code):**

```http
GET /auth/device/activate?code=ABCD-1234
Authorization: Bearer <token>
```

**Response (With Valid Code):**

```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "name": "My CLI Tool",
      "version": "1.0.0",
      "platform": "linux"
    },
    "expiresAt": "2024-01-01T12:15:00.000Z"
  }
}
```

**Error Cases:**

- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### POST /auth/device/authorize

**Requires Authentication** - Approve or deny device authorization request.

**Request Body:**

```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Fields:**

| Field      | Type    | Required | Description                    |
| ---------- | ------- | -------- | ------------------------------ |
| `userCode` | string  | Yes      | User code from the device      |
| `approve`  | boolean | Yes      | true to approve, false to deny |

**Response:**

```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

**Error Cases:**

- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### GET /auth/device/sessions

**Requires Authentication** - List current user's approved device sessions.

**Query Parameters:**

| Parameter | Type   | Required | Default | Description    |
| --------- | ------ | -------- | ------- | -------------- |
| `page`    | number | No       | 1       | Page number    |
| `limit`   | number | No       | 10      | Items per page |

**Response:**

```json
{
  "data": {
    "sessions": [
      {
        "id": "uuid-1234",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "name": "My CLI Tool",
          "version": "1.0.0",
          "platform": "linux"
        },
        "createdAt": "2024-01-01T12:00:00.000Z",
        "expiresAt": "2024-01-01T12:15:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10
  }
}
```

**Use Case:** View all devices that have been authorized to access the account.

---

#### DELETE /auth/device/sessions/:id

**Requires Authentication** - Revoke a specific device session.

**Parameters:**

- `id` (UUID) - Session ID to revoke

**Response:**

```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

**Error Cases:**

- 404 Not Found - Session not found or doesn't belong to current user

**Use Case:** Revoke access for lost or compromised devices.

---

### Test Authentication (Development/Test Only)

**Security Notice:** These endpoints are completely disabled in production. They exist solely to enable automated E2E testing without requiring real OAuth credentials.

#### POST /auth/test/login

**Development/Test Only** - Authenticate as a test user without OAuth.

**Availability:** Only when `NODE_ENV !== 'production'`

**Request Body:**

```json
{
  "email": "test@test.local",
  "role": "admin",
  "displayName": "Test Admin"
}
```

**Fields:**

| Field         | Type   | Required | Description                                                          |
| ------------- | ------ | -------- | -------------------------------------------------------------------- |
| `email`       | string | Yes      | Email address for test user                                          |
| `role`        | enum   | No       | Role to assign: `admin`, `contributor`, `viewer` (default: `viewer`) |
| `displayName` | string | No       | Display name for the user                                            |

**Response:** HTTP 302 redirect to `/auth/callback?token=<accessToken>&expiresIn=900`

- Sets HttpOnly refresh token cookie (same as OAuth flow)
- Creates user if not exists, assigns specified role

**Error Cases:**

- 403 Forbidden - Endpoint disabled (production environment)
- 400 Bad Request - Invalid email or role

**Use Case:** Playwright E2E tests use this endpoint to authenticate without Google OAuth.

---

### Users

**All user endpoints require Admin role (`users:read` or `users:write` permissions)**

#### GET /users

List all users with pagination and filtering.

**Query Parameters:**

| Parameter   | Type    | Default     | Description                                   |
| ----------- | ------- | ----------- | --------------------------------------------- |
| `page`      | number  | 1           | Page number                                   |
| `pageSize`  | number  | 20          | Items per page (max 100)                      |
| `search`    | string  | -           | Search by email or display name               |
| `isActive`  | boolean | -           | Filter by active status                       |
| `role`      | string  | -           | Filter by role name                           |
| `sortBy`    | enum    | `createdAt` | Sort field: `email`, `createdAt`, `updatedAt` |
| `sortOrder` | enum    | `desc`      | Sort order: `asc`, `desc`                     |

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "John Doe",
      "profileImageUrl": "https://...",
      "providerDisplayName": "John Doe",
      "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "roles": [
        {
          "id": "uuid",
          "name": "contributor"
        }
      ]
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

---

#### GET /users/:id

Get user by ID.

**Parameters:**

- `id` (UUID) - User ID

**Response:**

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "providerDisplayName": "John Doe",
  "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "roles": [
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ],
  "identities": [
    {
      "provider": "google",
      "providerEmail": "user@example.com"
    }
  ]
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

**Error Cases:**

- 404 Not Found - User not found

---

#### PATCH /users/:id

Update user properties (activation status, display name).

**Requires:** `users:write` permission

**Parameters:**

- `id` (UUID) - User ID

**Request Body:**

```json
{
  "isActive": false,
  "displayName": "New Name"
}
```

**Fields:**

| Field         | Type    | Required | Description                 |
| ------------- | ------- | -------- | --------------------------- |
| `isActive`    | boolean | No       | Activate or deactivate user |
| `displayName` | string  | No       | Update user's display name  |

**Response:**

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "New Name",
  "isActive": false,
  "roles": [
    {
      "id": "uuid",
      "name": "viewer"
    }
  ]
}
```

**Error Cases:**

- 404 Not Found - User not found

---

#### PUT /users/:id/roles

Update user roles (replaces all current roles).

**Requires:** `rbac:manage` permission

**Parameters:**

- `id` (UUID) - User ID

**Request Body:**

```json
{
  "roleNames": ["admin", "contributor"]
}
```

**Fields:**

| Field       | Type     | Required | Description                            |
| ----------- | -------- | -------- | -------------------------------------- |
| `roleNames` | string[] | Yes      | Array of role names to assign (min: 1) |

**Response:**

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    },
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ]
}
```

**Validation Rules:**

- Cannot remove own admin role (prevents accidental lockout)
- At least one role must be assigned
- Role names must exist in the system

**Error Cases:**

- 400 Bad Request - Invalid role names, empty array, or attempting to remove own admin role
- 401 Unauthorized - Not authenticated
- 403 Forbidden - Missing `rbac:manage` permission
- 404 Not Found - User not found

---

### Allowlist

**All allowlist endpoints require Admin role (`allowlist:read` or `allowlist:write` permissions)**

The allowlist restricts application access to pre-authorized email addresses. Users must have their email in the allowlist before they can complete OAuth login.

#### GET /allowlist

List allowlisted emails with pagination, filtering, and sorting.

**Query Parameters:**

| Parameter   | Type   | Default   | Description                                   |
| ----------- | ------ | --------- | --------------------------------------------- |
| `page`      | number | 1         | Page number                                   |
| `pageSize`  | number | 20        | Items per page (max 100)                      |
| `search`    | string | -         | Search by email                               |
| `status`    | enum   | `all`     | Filter by status: `all`, `pending`, `claimed` |
| `sortBy`    | enum   | `addedAt` | Sort by: `email`, `addedAt`, `claimedAt`      |
| `sortOrder` | enum   | `desc`    | Sort order: `asc`, `desc`                     |

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-01T00:00:00.000Z",
      "claimedBy": {
        "id": "uuid",
        "email": "user@example.com",
        "displayName": "John Doe"
      },
      "claimedAt": "2024-01-02T00:00:00.000Z",
      "notes": "New team member"
    },
    {
      "id": "uuid",
      "email": "pending@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-03T00:00:00.000Z",
      "claimedBy": null,
      "claimedAt": null,
      "notes": null
    }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`). `claimedBy` object contains `id`, `email`, and `displayName` when not null.

**Status Filters:**

- `all` - All allowlist entries
- `pending` - Emails not yet claimed by a user (claimedBy is null)
- `claimed` - Emails claimed by registered users (claimedBy is not null)

---

#### POST /allowlist

Add email to allowlist.

**Requires:** `allowlist:write` permission

**Request Body:**

```json
{
  "email": "newuser@example.com",
  "notes": "Marketing team member - starts next week"
}
```

**Fields:**

| Field   | Type   | Required | Description                            |
| ------- | ------ | -------- | -------------------------------------- |
| `email` | string | Yes      | Valid email address (case-insensitive) |
| `notes` | string | No       | Optional notes about this user         |

**Response:**

```json
{
  "id": "uuid",
  "email": "newuser@example.com",
  "addedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "addedAt": "2024-01-01T00:00:00.000Z",
  "claimedBy": null,
  "claimedAt": null,
  "notes": "Marketing team member - starts next week"
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`).

**Error Cases:**

- 409 Conflict - Email already exists in allowlist
- 400 Bad Request - Invalid email format

---

#### DELETE /allowlist/:id

Remove email from allowlist.

**Requires:** `allowlist:write` permission

**Parameters:**

- `id` (UUID) - Allowlist entry ID

**Response:** HTTP 204 No Content

**Error Cases:**

- 404 Not Found - Allowlist entry not found
- 400 Bad Request - Cannot remove entry that has been claimed by a user

**Note:** Entries that have been claimed (user has logged in) cannot be removed. This prevents accidentally removing access for existing users.

---

### Settings

#### GET /user-settings

**Requires Authentication** - Get current user's settings.

**Response:**

```json
{
  "theme": "light",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "version": 1
}
```

**Fields:**

| Field                      | Type           | Description                                       |
| -------------------------- | -------------- | ------------------------------------------------- |
| `theme`                    | enum           | UI theme: `light`, `dark`, `system`               |
| `profile.displayName`      | string \| null | User's display name override                      |
| `profile.useProviderImage` | boolean        | Whether to use OAuth provider's profile image     |
| `profile.customImageUrl`   | string \| null | Custom profile image URL                          |
| `updatedAt`                | string         | ISO 8601 timestamp of last update                 |
| `version`                  | number         | Version number for optimistic concurrency control |

---

#### PUT /user-settings

**Requires Authentication** - Replace all user settings.

**Request Body:**

```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  }
}
```

**Response:**

```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Note:** This replaces the entire settings object. Use PATCH for partial updates.

---

#### PATCH /user-settings

**Requires Authentication** - Partially update user settings.

**Request Body:**

```json
{
  "theme": "dark"
}
```

**Request Headers (Optional):**

```
If-Match: 1
```

**Response:**

```json
{
  "theme": "dark",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Optimistic Concurrency Control:**

- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates in concurrent scenarios

**Note:** This performs a shallow merge with existing settings.

---

#### GET /system-settings

**Requires:** `system_settings:read` permission (Admin only)

Get system-wide settings.

**Response:**

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 1
}
```

**Fields:**

| Field                          | Type    | Description                                       |
| ------------------------------ | ------- | ------------------------------------------------- |
| `ui.allowUserThemeOverride`    | boolean | Allow users to override system theme              |
| `security.jwtAccessTtlMinutes` | number  | JWT access token TTL in minutes                   |
| `security.refreshTtlDays`      | number  | Refresh token TTL in days                         |
| `features`                     | object  | Feature flags (extensible)                        |
| `updatedAt`                    | string  | ISO 8601 timestamp of last update                 |
| `updatedBy`                    | object  | User who last updated settings                    |
| `version`                      | number  | Version number for optimistic concurrency control |

---

#### PUT /system-settings

**Requires:** `system_settings:write` permission (Admin only)

Replace all system settings.

**Request Body:**

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {}
}
```

**Response:**

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

---

#### PATCH /system-settings

**Requires:** `system_settings:write` permission (Admin only)

Partially update system settings.

**Request Body:**

```json
{
  "ui": {
    "allowUserThemeOverride": false
  }
}
```

**Request Headers (Optional):**

```
If-Match: 1
```

**Response:**

```json
{
  "ui": {
    "allowUserThemeOverride": false
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

**Optimistic Concurrency Control:**

- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates when multiple admins modify settings concurrently

---

### Storage Objects

The storage system provides file upload and management capabilities with support for large files (GB scale) through resumable multipart uploads.

#### Initialize Resumable Upload

`POST /api/storage/objects/upload/init`

**Requires Authentication** - Initialize a multipart upload for large files. Returns presigned URLs for direct-to-S3 uploads.

**Request Body:**

```json
{
  "name": "document.pdf",
  "size": 104857600,
  "mimeType": "application/pdf"
}
```

**Response:**

```json
{
  "data": {
    "objectId": "uuid",
    "uploadId": "s3-upload-id",
    "partSize": 10485760,
    "totalParts": 10,
    "presignedUrls": [
      { "partNumber": 1, "url": "https://..." },
      { "partNumber": 2, "url": "https://..." }
    ]
  }
}
```

---

#### Get Upload Status

`GET /api/storage/objects/:id/upload/status`

**Requires Authentication** - Check progress of an in-progress upload.

**Response:**

```json
{
  "data": {
    "status": "uploading",
    "uploadedParts": 5,
    "totalParts": 10,
    "progress": 50
  }
}
```

---

#### Complete Upload

`POST /api/storage/objects/:id/upload/complete`

**Requires Authentication** - Finalize multipart upload after all parts are uploaded.

**Request Body:**

```json
{
  "parts": [
    { "partNumber": 1, "eTag": "\"etag1\"" },
    { "partNumber": 2, "eTag": "\"etag2\"" }
  ]
}
```

**Response:**

```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "processing"
  }
}
```

---

#### Abort Upload

`DELETE /api/storage/objects/:id/upload/abort`

**Requires Authentication** - Cancel an in-progress upload and clean up resources.

**Response:** HTTP 204 No Content

---

#### Simple Upload

`POST /api/storage/objects`

**Requires Authentication** - Direct upload for small files (< 100MB) using multipart/form-data.

**Request:**

- Content-Type: `multipart/form-data`
- Body: File attached as form data with key `file`

**Response:**

```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 1048576,
    "mimeType": "application/pdf",
    "status": "uploading"
  }
}
```

---

#### List Objects

`GET /api/storage/objects`

**Requires Authentication** - List storage objects with pagination and filtering.

**Query Parameters:**

| Parameter   | Type   | Default     | Description                                                               |
| ----------- | ------ | ----------- | ------------------------------------------------------------------------- |
| `page`      | number | 1           | Page number                                                               |
| `pageSize`  | number | 20          | Items per page (max 100)                                                  |
| `status`    | enum   | -           | Filter by status: `pending`, `uploading`, `processing`, `ready`, `failed` |
| `sortBy`    | enum   | `createdAt` | Sort field: `createdAt`, `name`, `size`                                   |
| `sortOrder` | enum   | `desc`      | Sort order: `asc`, `desc`                                                 |

**Response:**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "document.pdf",
      "size": 104857600,
      "mimeType": "application/pdf",
      "status": "ready",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

---

#### Get Object

`GET /api/storage/objects/:id`

**Requires Authentication** - Get storage object metadata.

**Response:**

```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "ready",
    "metadata": {
      "customField": "value"
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

#### Get Download URL

`GET /api/storage/objects/:id/download`

**Requires Authentication** - Get a signed download URL for the object.

**Query Parameters:**

| Parameter   | Type   | Default | Description               |
| ----------- | ------ | ------- | ------------------------- |
| `expiresIn` | number | 3600    | URL expiration in seconds |

**Response:**

```json
{
  "data": {
    "url": "https://s3.amazonaws.com/...",
    "expiresAt": "2024-01-01T01:00:00.000Z"
  }
}
```

---

#### Delete Object

`DELETE /api/storage/objects/:id`

**Requires Authentication** - Delete a storage object and its associated file.

**Response:** HTTP 204 No Content

**Error Cases:**

- 404 Not Found - Object not found
- 403 Forbidden - User does not own object (non-admin)

---

#### Update Metadata

`PATCH /api/storage/objects/:id/metadata`

**Requires Authentication** - Update custom metadata for an object.

**Request Body:**

```json
{
  "metadata": {
    "customField": "value",
    "tags": ["document", "important"]
  }
}
```

**Response:**

```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "metadata": {
      "customField": "value",
      "tags": ["document", "important"]
    },
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### Projects

A grouping repositories are optionally filed into (#404, epic #403). Requires
`projects:read` to read and `projects:write` to change — the same pair
`RepositoriesController` enforces, because a project is administered by
whoever administers the repositories in it and carries no authority of its
own: nothing reads `projectId` to decide whether a run may happen (VISION
§11's single-operator premise).

#### GET /projects

List projects, paginated. Each row carries `repositoryCount`, so a list is
useful without one request per project.

**Query parameters:**

| Parameter  | Type   | Default | Description                                       |
| ---------- | ------ | ------- | ------------------------------------------------- |
| `page`     | number | `1`     | 1-based page number                               |
| `pageSize` | number | `25`    | Max 100                                           |
| `search`   | string | —       | Case-insensitive substring over `name` and `slug` |

**A repository with no project is not listed here and is not missing.**
`projectId: null` is a first-class state — see [Repositories](#repositories)
below and `GET /repositories?projectId=none`.

#### GET /projects/{id}

Get one project.

#### POST /projects

Create a project.

**Request:**

```json
{ "name": "Billing Platform", "slug": "billing", "description": "Optional" }
```

`slug` is optional and derived from `name` when omitted —
`"Billing Platform"` becomes `billing-platform`. Derivation happens **once**,
at creation; renaming a project later does not move its slug.

**A taken slug is refused, never silently suffixed.** Appending `-2` would
hand back a handle nobody chose and leave every later reference to the
original resolving to somebody else's project. The `409` names the slug that
collided, including when it was derived and the caller never typed it. A name
with no character in the slug alphabet (e.g. `"日本語"`) derives nothing and
is a `400` asking for an explicit slug.

**Response:** `201` with the project.

**Errors:**

| Status | Cause                                              |
| ------ | -------------------------------------------------- |
| `400`  | Invalid, or no slug could be derived from the name |
| `409`  | That slug is already taken                         |

#### PATCH /projects/{id}

Update `name`, `slug` and/or `description`. Omitted fields are left unchanged.
At least one field must be present, or the request is a `400` rather than a
`200` reporting success for a write that did nothing.

**Renaming does not move the slug** — changing it is possible but has to be
asked for explicitly, since the slug is the stable handle everything else
referenced.

#### DELETE /projects/{id}

Delete a project. **Its repositories are NOT deleted.** They become
unassigned — still registered, still observed, still dispatchable — the same
state every repository was in before projects existed.

**Unlike `DELETE /repositories/{id}`, this is never refused for having
contents.** A project owns no work orders, no runs and no events, so nothing
in the provenance graph VISION §5 protects depends on it; the foreign key is
`ON DELETE SET NULL`, not cascade. The only thing removed is the label.

**Response:** `200` with `{ "id", "slug", "unassignedRepositories" }` rather
than a bare `204`, so the non-cascade guarantee is visible in the answer
itself.

#### PUT /projects/{id}/repositories/{repositoryId}

Assign a repository to this project. Idempotent, and it **moves**: a
repository already in another project is reassigned. Equivalent to
`PATCH /repositories/{repositoryId}` with `{ "projectId": id }`, and runs the
same code — this spelling exists because repositories are managed from inside
a project screen.

#### DELETE /projects/{id}/repositories/{repositoryId}

Remove a repository from this project. **Removes the grouping, not the
repository** — it stays registered and becomes unassigned.

`404` when the repository is in a _different_ project: this path asserts the
repository is in `id`, and acting anyway would let a stale screen unassign it
from wherever it was actually moved to.

---

### Repositories

Which repositories Opifex watches, and the policy for each. Requires
`projects:read` to read and `projects:write` to change.

Observation and dispatch are **separate switches** on purpose. VISION §12
requires the reconciler to run read-only for an observation week before it is
allowed to act, and that week has to end one repository at a time — a single
`enabled` flag would leave no way to do that except globally.

#### GET /repositories

List registered repositories. Paginated.

**Query parameters:**

| Parameter         | Type           | Default | Description                                                                        |
| ----------------- | -------------- | ------- | ---------------------------------------------------------------------------------- |
| `page`            | number         | `1`     | 1-based page number                                                                |
| `pageSize`        | number         | `25`    | Max 100                                                                            |
| `observeEnabled`  | boolean        | —       | Filter to what the reconciler reads                                                |
| `dispatchEnabled` | boolean        | —       | Filter to what may be dispatched                                                   |
| `projectId`       | uuid or `none` | —       | A project's id, or `none` for repositories in no project at all                    |
| `retired`         | boolean        | —       | Filter on retirement. Omitted returns **both** — a retired repository stays listed |

**`projectId=none` is a first-class answer, not a workaround.** Every
repository registered before projects existed is unassigned, and unassigned
is an _answer_ to "which project", not a different question — which is why
it is a value of this filter rather than a separate `unassigned` flag. See
[Projects](#projects) above.

#### GET /repositories/available

List the repositories the **configured GitHub credential can reach**, so
`owner/name` is chosen from a list rather than typed from memory. Paginated,
with `?search=` applied server-side over the whole reachable set.

Every repository the token can see is returned, and the unaddable ones are
**marked** rather than filtered out: `admission` is `available`, `registered`
(with `repositoryId` pointing at the existing row — the `409` this endpoint
exists to spare a caller) or `archived` (which `POST /repositories` refuses).

**A failure is a `200` carrying a `status`, not an error status** —
`no_credential`, `invalid_credential`, `refused`, `rate_limited`,
`unreachable` or `failed`, each with its own `detail`. `reachable: 0` under
`status: "ok"` is a successful answer: the credential works and its scope
covers nothing. `truncated: true` means GitHub's own listing hit its page cap
and the list is not complete.

**Registering several repositories from this list is one request per
repository, sequential rather than concurrent** — see
`docs/RUNBOOK-observation-week.md` §4 and `docs/ARCHITECTURE.md` §3.10.
Each registration's reachability check spends a real GitHub request against
the budget `github.rateLimitReserve` protects for interactive use, and
nothing rolls back across repositories: a refusal partway through a batch of
manual adds leaves the earlier ones registered.

#### GET /repositories/{id}

Get one registered repository.

#### POST /repositories

Register a repository.

**Verifies the repository is reachable** with the configured GitHub credential
before accepting it — an entry Opifex cannot read would turn every subsequent
reconciler tick into a 404. The default branch is read from GitHub rather than
assumed, because a work order pins its base commit on that branch.

**Request:**

```json
{
  "owner": "marinoscar",
  "name": "opifex",
  "projectId": null,
  "observeEnabled": true,
  "dispatchEnabled": false,
  "mirrorLabelsEnabled": false,
  "budgetCeilingUsd": 5.0,
  "wallClockTimeoutMinutes": 30,
  "pathConstraints": ["apps/api/**"]
}
```

Only `owner` and `name` are required. `projectId` is optional and defaults to
unassigned (`null`) — a normal, first-class state, not a placeholder for a
project to be chosen later. `dispatchEnabled` and `mirrorLabelsEnabled` both
default to **false**: a newly registered repository is observed, written to
by nothing, and never run, until a human says otherwise.

The three switches are separate on purpose, so VISION §12's observation week
can end in stages — observe, then write mirror labels, then dispatch. Proving
the write path before dispatch exists is the point of doing labels first, and
a single `enabled` flag would make the first write and the first run happen on
one flip. `mirrorLabelsEnabled` is gated a second time by the global
`GITHUB_WRITES_ENABLED`; both must be on for a label to be written.

**It also creates the factory label taxonomy on the repository** (#415).
`factory:ready` is the whole eligibility signal, and GitHub's label picker
only offers labels that exist — so a repository registered without them
cannot be steered at all. Fifteen of the taxonomy's 40 labels are provisioned:
the three `factory:*` input labels, the five `factory/*` mirror labels, and
the seven `needs:*` / `tier:*` routing labels. The 25 organisational labels
(`bug`, `phase:*`, component labels, …) are not — see [`GET
/repositories/{id}/labels`](#get-repositoriesidlabels) below for why.

**Provisioning failing does NOT fail the registration.** ADR-0001's
fine-grained personal access token grants access one repository and one
permission at a time and emits no `x-oauth-scopes` header, so whether it can
create a label on this repository is unknowable until it is tried. The
repository is registered either way, and the response's `labelProvisioning`
reports what happened.

**Response:** `201` with the repository, including its `fullName`, the
`defaultBranch` read from GitHub, and `labelProvisioning` — the same report
shape `GET /repositories/{id}/labels` answers (below). `ok: true` means every
declared label is present; `status: "refused"` is the likeliest failure —
the token authenticated and is not permitted to write this repository's
labels, the remedy is granting it `Issues: Read and write`, and
`POST /repositories/{id}/labels` repairs it once that is done. When the
labels could not even be read, every count on the report is `null` —
**null means the labels were never read, never that there are none.**

**Errors:**

| Status | Cause                                                                   |
| ------ | ----------------------------------------------------------------------- |
| `400`  | Not reachable (does not exist, or the token cannot see it), or archived |
| `409`  | Already registered                                                      |
| `503`  | The GitHub credential is missing, expired, or lacks access              |

#### PATCH /repositories/{id}

Update the policy. Omitted fields are left unchanged; an explicit `null` clears
a ceiling.

**Enabling dispatch re-verifies reachability** — that is the moment a
repository stops being observed and starts being written to, so a token whose
access was revoked since registration must not have dispatch turned on against
it. Disabling never re-verifies: that has to work precisely when GitHub is
unreachable.

**Refused with `400` while the repository is retired, if the request would
raise any ladder rung** (`observeEnabled`, `mirrorLabelsEnabled`,
`specFeedbackEnabled` or `dispatchEnabled` set `true`). The error names the
rungs and points at `POST /repositories/{id}/unretire`. Everything else —
`projectId`, budget ceiling, timeout, path constraints — stays editable on a
retired repository, because those change what a future run would be allowed
to do, not whether one can happen.

#### POST /repositories/{id}/retire

Stand a repository down: `observeEnabled`, `mirrorLabelsEnabled`,
`specFeedbackEnabled` and `dispatchEnabled` all set `false`, in one
transaction, with an `audit_events` row recording who did it, an optional
free-text `reason`, and the ladder position it was standing on beforehand
(`meta.ladderBefore`).

**This is not a delete, and nothing is destroyed.** The repository stays
registered and listed (filter with `?retired=`); its work orders, runs and
provenance are untouched. That is the point — `DELETE` is refused on a
repository with work orders precisely because removing it would cascade that
history away, and retire is the removal action that still works on the
repositories an operator most wants to tidy: the used ones.

**"Retired" is a stored fact** (`retiredAt`, `retiredById`), not a reading of
the four flags — see `docs/ARCHITECTURE.md` §3.10 for the full argument
(#405). All four flags off is also what four separate `PATCH`es produce, and
an operator who paused observation for an afternoon has not retired
anything.

**Idempotent.** Retiring an already-retired repository returns it unchanged
and writes no second audit row.

**Request body (optional):** `{ "reason": "..." }` — up to 500 characters,
recorded on the audit row.

**Response:** `200` with the retired repository.

#### POST /repositories/{id}/unretire

Return a retired repository to the **bottom** of the enablement ladder:
`observeEnabled` on, every outward write (`mirrorLabelsEnabled`,
`specFeedbackEnabled`, `dispatchEnabled`) off — the same position a freshly
registered repository lands in.

**Does NOT restore the rungs the repository previously held.** Retiring is
often the response to a repository doing something unwanted; silently
switching dispatch back on would re-enable the factory's most consequential
permission as a side effect of an undo. Ask for a rung back explicitly with
`PATCH`, which re-verifies reachability. The rungs it held before retirement
survive only in the retire audit row's `meta.ladderBefore` — un-retiring does
not read them.

**Idempotent.** Un-retiring a repository that is not retired returns it
unchanged and does not reset its ladder.

**Request body (optional):** `{ "reason": "..." }`, recorded on the audit row.

**Response:** `200` with the repository, back at the bottom of the ladder.

#### DELETE /repositories/{id}

De-register a repository. Returns `204`.

**Refused with `400` while the repository has work orders.** Deleting would
cascade away runs and their provenance, and VISION §5's premise is that the
chain survives. Retire it instead (`POST /repositories/{id}/retire`), which
stands the whole ladder down in one act and leaves that history in place.

#### GET /repositories/{id}/labels

Check which of the declared factory labels exist on this repository, as of
right now (#415). **Writes nothing** — the observed half of the ladder,
paired with `POST` below the way `POST /api/settings/probes/:probe` already
pairs a check with a repair. Requires `projects:read`.

Answers a `LabelProvisioningReport`: an **observation** with a `checkedAt`,
not a stored fact — a label added or removed on GitHub since the last check
is not reflected until you check again.

**Per-label, not just a count.** `labels[]` names every declared label with
`stateBefore` (`present`, `missing`, or `drifted` with `differences`), so a
caller can say _which_ label is absent rather than only how many. `present` /
`declared` is the "N of M labels present" summary.

**Three kinds are declared**, and `labels[].kind` names which:

| Kind      | Prefix              | What's lost while it's missing                                                            |
| --------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `input`   | `factory:*`         | The repository cannot be steered at all — `factory:ready` is the whole eligibility signal |
| `mirror`  | `factory/*`         | GitHub creates one on first write anyway, with a random colour and no description         |
| `routing` | `needs:*`, `tier:*` | Work still runs, but only ever on the defaults                                            |

This repository's organisational labels (`bug`, `phase:*`, component labels)
are deliberately not part of the taxonomy this endpoint reports on — see
`docs/RUNBOOK-observation-week.md` §3 for why, and `scripts/sync-labels.mjs`
for the tool that covers them.

**Every count is `null` when the labels could not be read, and `null` means
NOT READ — never zero.** `declared`, `present`, `missing`, `created`,
`updated`, `unchanged` and `failed` go `null` together whenever GitHub's
label list was never obtained: a refused, expired or absent credential, a
404, an exhausted rate-limit budget, an unreachable GitHub. A token that
cannot read a repository's labels establishes nothing about what is on it,
so rendering "0 of 15 present" from such a report would state a fact nobody
found out. `labels` is `[]` in the same case.

**Check the `null`, not the `status`, to decide whether the counts are
trustworthy.** A repair whose _write_ was refused (`status: "refused"`)
still carries real counts, because its read succeeded and only the write
that followed was cut off — see [`POST
/repositories/{id}/labels`](#post-repositoriesidlabels) below.

**A failure is a `200` carrying a `status`, not an error status** —
`no_credential`, `invalid_credential`, `refused` (authenticated, not
permitted — the likeliest failure, since ADR-0001's fine-grained token can
read a repository it cannot label), `not_found`, `rate_limited`,
`unreachable`, or `failed`. `labels` is empty and every count is `null` in
every one of these.

#### POST /repositories/{id}/labels

Create the missing factory labels and update the drifted ones on this
repository (#415). The repair action for a repository whose registration
provisioning was refused, or one registered before #415 shipped. Requires
`projects:write`. Returns **`200`**, not `201` — this is a repair, not a
creation of a new resource, and no request body is taken: there is nothing
to choose, only the declared taxonomy to apply.

**It never deletes.** A label present on the repository and absent from the
taxonomy is left exactly as it is — deleting one strips it from every issue
carrying it, and that is not recoverable from a declaration that knows names
and colours but not which issues had them.

**Idempotent.** It reads the repository's labels first and writes only the
difference, so running it twice creates nothing the second time; `unchanged`
counts the labels that needed no write at all.

**Not gated by `github.writesEnabled`.** That switch governs whether the
factory acts on issues during a reconciler tick; creating the taxonomy is
operator setup, the same category as registering a repository. Gating it on
the kill switch would mean VISION §12's observation week could not be set up
without turning on the very writes the switch exists to withhold.

**Response:** `200` with the same `LabelProvisioningReport` shape as `GET`
above, with `attempted: true` and `created` / `updated` / `failed` filled in.
`attempted` means this call **tried** to write — not that the writes landed:
a refused repair is `attempted: true` having written nothing, and the
outcome is `status`, `created` and `failed`. A refusal is a `200` with
`status: "refused"`, and — because the read that preceded the refused write
succeeded — its counts are real, not `null`; only a report whose _read_
failed has `null` counts.

---

### Cockpit

The read models the operator dashboard is built on. These answer operational
questions rather than returning rows for the browser to interpret — the verdict
about _why_ a work order is not running is the control plane's, and a UI that
recomputed it would be a second implementation of dispatch policy, out of date
by one poll interval and wrong the moment the rules change.

#### `GET /api/queue`

Queued and held work orders, in dispatch order. Requires `workorders:read`.

| Query   | Type   | Default | Notes  |
| ------- | ------ | ------- | ------ |
| `limit` | number | `25`    | 1–100. |

**Position 1 is what the next reconciler tick will pick up.** The order is the
same one the dispatch pass drains in (`queuedAt` ascending), which is what makes
`position` a fact rather than a decoration. Held work orders have no `queuedAt`
— it is nulled so releasing one cannot jump the queue — so they sort last, and
their `enqueuedAt` falls back to when the row was created.

**Dispatched work orders are not listed.** They have a run against them and
belong to the runs view; listing them here as well would make queue depth read
high while the factory is busy working through it.

`state` is the answer to "why is this not running yet":

| State         | Meaning                                                   | Clears when                 |
| ------------- | --------------------------------------------------------- | --------------------------- |
| `ready`       | A runner could take it right now                          | The next tick dispatches it |
| `waiting`     | No capable runner, or the rows ahead take every free slot | On its own                  |
| `held`        | A `factory:hold` label, or a quarantine                   | **A human acts**            |
| `dispatching` | In the vocabulary, never returned — see below             | —                           |

`held` is kept apart from `waiting` because they call for opposite responses:
waiting is a scheduling outcome that resolves itself, held is a policy outcome
that does not.

`dispatching` is never emitted. A work order stops being `queued` the instant
the executor creates its `Run` row, inside the same pass, so there is no
committed state between the two for this endpoint to observe. It stays in the
vocabulary because the state becomes real the moment dispatch is asynchronous.

`waitingOn` carries one line naming what must clear. Where the dispatch policy
refused the work order, it is **the policy's own sentence verbatim** — an
operator comparing this panel against the dispatch log should read the same
words in both, not two paraphrases.

```json
{
  "data": [
    {
      "id": "3f2a...",
      "workOrder": {
        "id": "wo_opifex_312_a3f91c2_a1",
        "issueNumber": 312,
        "repository": "marinoscar/opifex",
        "baseCommit": "a3f91c2",
        "attempt": 1,
        "branch": "factory/312-a3f91c2-a1",
        "title": "Add a permit search prompt builder",
        "issueUrl": "https://github.com/marinoscar/opifex/issues/312"
      },
      "state": "waiting",
      "position": 3,
      "enqueuedAt": "2026-08-23T03:00:00.000Z",
      "waitingOn": "Waiting for a free slot on claude-code-local; the work orders ahead of it take them all"
    }
  ]
}
```

`baseCommit` is shortened to 7 characters by the API. `id` and `branch` are
carried verbatim rather than recomposed from the parts: re-run idempotency rests
on those strings matching exactly, so nothing downstream may re-derive them.

**Hold and release are not here.** They are a write path with different
authorization stakes than this read model and are documented immediately
below (#116).

---

#### `POST /api/queue/{workOrderId}/hold`

Write `factory:hold` to the work order's GitHub issue. Requires
`workorders:write`.

#### `POST /api/queue/{workOrderId}/release`

The counterpart: writes `factory:ready`. Same permission, same rules. The two
are documented together because they share every shape and caveat below.

`{workOrderId}` accepts either the row id or the work-order identity
(`wo_opifex_312_a3f91c2_a1`) — the identity is what a human recognises and
what a commit trailer carries, so the URL is usable from outside the cockpit
too. `404` if neither matches an existing work order.

**This is a UI over the input labels, not a second state machine (#116).**
Neither endpoint touches the work order's row directly. Each writes exactly
one label to the GitHub issue and returns; the reconciler's next tick is what
actually moves the work order between `queued` and `held`. VISION §3.3 makes
labels "a bidirectional edge, never the state machine" — a work order held
through this endpoint and one held by editing the label on GitHub by hand are
the same thing afterward, never two paths that can disagree.

**Response — `202 Accepted`, unconditionally, whether or not the label
reached GitHub:**

```json
{
  "data": {
    "workOrderId": "wo-uuid",
    "identity": "wo_opifex_312_a3f91c2_a1",
    "label": "factory:hold",
    "labelWritten": true,
    "reconciled": false,
    "effect": "The label is the request. It takes effect on the next reconciler tick."
  }
}
```

| Field          | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `labelWritten` | Whether the label actually reached GitHub. `false` when `github.writesEnabled` is off. |
| `reconciled`   | Always `false`. Reconciliation is a later tick's job, never this call's.               |
| `effect`       | One sentence, meant to be rendered verbatim rather than paraphrased.                   |

**Check `labelWritten` in the body, not the status code — both endpoints
answer `202` either way.** The request having been accepted and audited is a
separate fact from the label having reached GitHub. With `github.writesEnabled`
off (the operator-managed kill switch, default `false` — see
`docs/RUNBOOK-observation-week.md`), `labelWritten` comes back `false` and no
label was written, so **no reconciler tick will ever act on this request**. A
client that treats `202` alone as success will report a hold or a release
that never happened. This is the same distinction `POST
/repositories/{id}/labels` draws between `attempted` and the write counts
above: the call succeeding at being received is not the same fact as it
having changed anything on GitHub, and the second fact is only in the body.

**Audited regardless of `labelWritten`.** An `audit_events` row (`queue.hold`
/ `queue.release`) is written before the response is returned, whether or not
the label reached GitHub, with `meta.labelWritten` recording which. "Who
asked for this and when" is the fact worth keeping, and a request whose write
failed is exactly the one somebody will later need to find.

**Release does not clear a quarantine.** There is deliberately no endpoint
for `factory:clear-quarantine`: #49 requires a human apply it directly on
GitHub, where the applier's identity is native and verifiable from the issue
timeline. Proxying it through this API would launder the actor — every clear
would look like it came from the Opifex token, and VISION §8's rule that an
agent cannot clear its own quarantine would stop being enforceable. Writing
`factory:ready` to a quarantined work order does not unstick it.

**Releasing re-stamps `queuedAt` — but only for a work order that was
actually held.** Lifting a hold sets `{ status: 'queued', queuedAt: new
Date() }`, so the work order rejoins the queue at the **back**, not at the
position it left from (`work-order-projection.service.ts`'s `reconcileHold`).
That reconciliation step returns immediately whenever the desired state
already matches the current one, so releasing a work order that is not
currently `held` still writes the label and the audit event, but does not
touch `queuedAt` — there is nothing to re-stamp, and the work order's queue
position is unaffected. The endpoint's response does not distinguish the two
cases; both answer identically.

---

**Bulk steering from the queue screen is these same two endpoints, called
several times (#421).** The queue screen's multi-select "Hold" / "Mark ready"
controls are not a separate endpoint. Selecting several work orders and
pressing one button issues this same `hold`/`release` request once per work
order, **sequentially** — not in parallel, and not inside a database or
GitHub transaction.

- **Partial success is the ordinary outcome, not an error.** A run of fifteen
  is sometimes eleven writes and four refusals; nothing rolls the eleven back,
  and the outcome is reported **per work order**, never as one pass/fail for
  the whole batch.
- **Whatever did not land stays selected.** Both refusals (4xx/5xx responses)
  and suppressed writes (`labelWritten: false`) leave that work order selected
  after the run, so a retry re-sends only what has not worked yet. A work
  order whose label already reached GitHub drops out of the selection and
  cannot be re-sent by the same click.
- **Select-all is bounded to the current page.** It can only select the work
  orders the `GET /api/queue` response actually returned. That response is a
  bare array with no total count, so the UI has no number to offer "select all
  N" beyond what is rendered, and there is no way for a selection to reach
  past it.

---

#### `GET /api/runs`

Runs, newest first. Requires `runs:read`.

| Query               | Type    | Default    | Notes                                                                  |
| ------------------- | ------- | ---------- | ---------------------------------------------------------------------- |
| `page` / `pageSize` | number  | `1` / `25` | `pageSize` max 100.                                                    |
| `needsAttention`    | boolean | —          | See below.                                                             |
| `status`            | enum    | —          | `running`, `succeeded`, `stalled`, `blocked`, `failed`, `quarantined`. |

**`needsAttention` means "has an escalation nobody has acknowledged or
resolved"** — not a status list. The obvious `status IN (stalled, failed,
quarantined)` never drains: a run that failed last Tuesday is still `failed`
today, so the panel fills with history and the thing needing a human right now
is on page three. The escalation lifecycle (#57) is the mechanism built to be
resolved, and this filter reuses the same `UNRESOLVED` set the notification path
dedupes on, so the two cannot disagree.

It is a **server-side** filter deliberately: whether a run needs a human is the
control plane's verdict, and a UI filtering by status locally would be the
watchdog re-implemented in a browser, out of date by one poll interval.

With `needsAttention=true`, results are ordered by **longest silence first**,
with never-reported runs at the very top — `lastEventAt` is the age the panel is
about, and a run that has never reported anything is the worst case rather than
a null to sort past. Unfiltered, results are newest-started first.

**One known lag.** The poller writes `attentionReason` the moment it finds a run
with no handle, before any escalation exists; in that window the run is not
listed. It closes on its own — the watchdog sweeps `stalled` runs too and
escalates once the run has been silent long enough. Widening the filter to
`attentionReason IS NOT NULL` would trade that bounded lag for an unbounded one,
since nothing clears that column and the panel would never drain.

#### `GET /api/runs/{id}`

One run. Requires `runs:read`. `404` if it does not exist.

**`attentionReason` and `resumesAt` are separate fields and must stay that way.**
VISION §9 gives three failure modes three different responses, and the
operator's next move is decided by which is populated:

| Field set         | Meaning                   | What to do                         |
| ----------------- | ------------------------- | ---------------------------------- |
| `attentionReason` | A human has to act        | Kill, re-plan, review a quarantine |
| `resumesAt`       | The system will handle it | Nothing — acting is wasted effort  |

A single "message" field would destroy exactly that distinction.

`costUsd` is `null` when the runner reports no cost — which is not the same
claim as a run that was free.

#### `GET /api/work-orders`

Every work order, newest first. Requires `workorders:read`.

| Query               | Type   | Default    | Notes                                                                                                       |
| ------------------- | ------ | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `page` / `pageSize` | number | `1` / `25` | `pageSize` max 100.                                                                                         |
| `status`            | enum   | —          | `pending`, `queued`, `held`, `dispatched`, `succeeded`, `failed`, `quarantined`, `superseded`, `cancelled`. |
| `repository`        | string | —          | `owner/name`.                                                                                               |

Unlike `/queue` — which lists only what is waiting, in dispatch order — this is
**history**: every state a work order can reach. `runCount` is how many runs have
been made against it, which is what #66 judges decomposition quality on.

`baseCommit` is shortened to 7 here, because it is a label in a table.

#### `GET /api/work-orders/{idOrIdentity}`

One work order and **the document it authorized**. Requires `workorders:read`.

Accepts either the row id or the identity (`wo_opifex_312_a3f91c2_a1`). The
identity is the string an operator actually has — it is what the authorization
record shows and what the branch name encodes — so requiring a uuid they have
never seen would be a lookup key chosen for the database's convenience.

**`document` is rebuilt from the row and passed through the same serializer**
that produced the bytes committed to the factory branch and posted to the issue
(#63, #154). It is not a second rendering of the same columns. That distinction
is the whole point: #63's premise is that _"the agent did something I did not ask
for"_ is a checkable claim, and it stops being checkable the moment the cockpit
shows a lookalike. Comparing this against the authorization record on the issue
is a real check.

**A row whose stored identity its own coordinates do not derive returns `422`**,
not a best-effort document. Serving the raw columns anyway would put a document
in front of an operator that nothing ever authorized. The row still appears in
the list, so the work order does not vanish — only the claim "this is what was
authorized" is withheld.

`baseCommit` is returned **in full** here, unlike on the list: this one is meant
to be checked out, and a 7-character prefix is not a git ref you can rely on
resolving in a repository with enough history.

`authorizationCommentUrl` is the traversable edge VISION §5 rests on — the link
from the work order to the human-readable proof it was authorized. Null until
dispatch posts it; never reconstructed from the issue URL, which would be a guess
about where dispatch commented.

```json
{
  "data": {
    "id": "3f2a…",
    "status": "dispatched",
    "holdReason": null,
    "queuedAt": "2026-08-23T01:00:00.000Z",
    "createdAt": "2026-08-23T00:30:00.000Z",
    "authorizationCommentUrl": "https://github.com/marinoscar/opifex/issues/312#issuecomment-9",
    "baseCommit": "a3f91c2000000000000000000000000000000000",
    "document": {
      "schemaVersion": "1.0.0",
      "identity": "wo_opifex_312_a3f91c2_a1",
      "branch": "factory/312-a3f91c2-a1",
      "repository": { "owner": "marinoscar", "name": "opifex" },
      "baseCommit": "a3f91c2000000000000000000000000000000000",
      "attempt": 1,
      "issue": {
        "number": 312,
        "url": "https://github.com/marinoscar/opifex/issues/312"
      },
      "decisionRefs": ["ADR-0042"],
      "taskSpec": "…",
      "acceptanceCriteria": ["…"],
      "pathConstraints": ["apps/api/**"],
      "budgetCeilingUsd": 5,
      "wallClockTimeoutMinutes": 30,
      "needs": ["full-streaming"]
    },
    "runs": [
      {
        "id": "…",
        "status": "succeeded",
        "runner": "claude-code-local",
        "startedAt": "2026-08-23T02:00:00.000Z",
        "endedAt": "2026-08-23T02:30:00.000Z",
        "costUsd": 2.5,
        "pullRequestUrl": "https://github.com/marinoscar/opifex/pull/9"
      }
    ]
  }
}
```

#### `GET /api/events`

The normalized event floor across every run, newest first. Requires `runs:read`.

| Query               | Type   | Default    | Notes                                                                                         |
| ------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------- |
| `page` / `pageSize` | number | `1` / `20` | `pageSize` max 200.                                                                           |
| `type`              | enum   | —          | `run.started`, `run.heartbeat`, `run.progress`, `run.blocked`, `run.completed`, `run.failed`. |
| `source`            | enum   | —          | `runner`, `git`, `control-plane`.                                                             |

**Not the same as `/runs/{id}/events`**, which is one run's timeline. This spans
runs, so every row names its `runId` and the work order `identity` it belongs
to — a feed of _"edited a file"_ with no subject is a list of sentences nobody
can act on.

The default page is **20**, matching what the dashboard panel asks for.
`RunEvent` is high-volume (#39): a single run emits a progress event per tool
call plus heartbeats, so a handful of live runs produces a feed that scrolls
faster than anyone reads.

Ordered `occurredAt` then `recordedAt`. The tiebreak is load-bearing — two
events can share a reported millisecond, and an unstable sort would shuffle them
between pages so a reader could see one twice and another never.

`source` says whether a runner **reported** the event, the git watcher
**derived** it, or the control plane **synthesized** it. VISION §9 requires that
a synthesized event never masquerade as a report, which is why it is a field
rather than a note in the summary text.

**Filters take the wire spelling, never the database's.** `?type=run.started`,
not `run_started`; `?source=control-plane`, not `control_plane`. Postgres cannot
hold a dot in an enum label, so the stored labels differ from the names that
appear in `schemas/run-event.schema.json`, in a runner's output, and in this
API's own responses — and a caller should never have to know that.

```json
{
  "data": {
    "items": [
      {
        "id": "…",
        "type": "run.blocked",
        "source": "control-plane",
        "occurredAt": "2026-08-23T01:04:00.000Z",
        "runId": "…",
        "workOrderId": "wo_opifex_312_a3f91c2_a1",
        "summary": "rate limited until 06:00"
      }
    ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

#### `GET /api/cost/summary`

Spend over a window, with the unmeasured part counted. Requires `runs:read`.

| Query  | Type   | Default | Notes                |
| ------ | ------ | ------- | -------------------- |
| `days` | number | `30`    | Window length, 1–90. |

**Read `totalUsd` and `runsWithoutCost` together.** `Run.costUsd` is nullable
because a runner may not report cost at all — `reportsCost` is in the capability
manifest (#32) precisely so a runner that does not is a supported case, not a
broken one. So a total over a window where most runs reported nothing is a
**floor, not a figure**, and a cost screen showing only the total would
understate spend while looking precise. VISION §10 makes cost per merged PR the
economic-viability metric; an understated numerator flatters it.

`totalUsd` is `null`, never `0`, when nothing reported — per repository as well
as overall. "No run reported a cost" and "the factory spent nothing" are
different claims.

`byRepository` sorts biggest spender first with **unknowns last**: a `null`
sorting high would put the least informative row where the eye lands.

`byDay` carries only days that had reported spend, oldest first — the same rule
the metrics trend follows. Totals round to cents, because a `Decimal(10,4)`
column summed as floats produces tails like `0.30000000000000004`, and a cost
screen showing that has lost the reader over an artefact of the language.

**`quota` is always `null`, and present rather than omitted.** VISION §11's
shared quota is the agent subscription, and nothing records consumption against
a window capacity — `RunEvent.blockedUntil` holds a reset _time_, never a burn
rate. The GitHub rate limit _is_ measured and could be divided by its window;
that would answer a different question under this one's label. The field is
named so a cost-and-quota screen (#86) can say "unavailable" rather than looking
like quota was forgotten. Same absence that makes `quotaBurn` null in
`/metrics/summary`.

```json
{
  "data": {
    "generatedAt": "2026-08-23T05:00:00.000Z",
    "window": {
      "from": "2026-07-24T05:00:00.000Z",
      "to": "2026-08-23T05:00:00.000Z"
    },
    "totalUsd": 5.3,
    "runs": 5,
    "runsWithoutCost": 2,
    "byRepository": [
      {
        "repository": "probe-owner/alpha",
        "totalUsd": 5.3,
        "runs": 3,
        "runsWithoutCost": 0
      },
      {
        "repository": "probe-owner/beta",
        "totalUsd": null,
        "runs": 2,
        "runsWithoutCost": 2
      }
    ],
    "byDay": [
      { "date": "2026-08-18", "totalUsd": 5 },
      { "date": "2026-08-21", "totalUsd": 0.3 }
    ],
    "quota": null
  }
}
```

#### Projects and repositories

**Not cockpit read models — a full resource each, with writes.** `GET /api/repositories`
was gated on `projects:read` since #43 and was, for a while, the only endpoint
the `/projects` screen needed; that stopped being true once #404/#403 gave
`Project` its own CRUD and #406 moved repository management (adding,
enabling, retiring, moving between projects) onto the same screen. See
[Projects](#projects) and [Repositories](#repositories) above for the actual
endpoints — there is no separate cockpit-only shape for either.

#### `GET /api/metrics/summary`

The six VISION §10 success metrics, in one request. Requires `runs:read`.

| Query  | Type   | Default | Notes                |
| ------ | ------ | ------- | -------------------- |
| `days` | number | `7`     | Window length, 1–90. |

**One request for the whole stat row, not six** — six requests to paint one row
is six chances to render a half-updated screen.

**A `value` of `null` means NOT MEASURED. It never means zero.** The cockpit
renders `null` as an em dash and its `MetricTile` has no code path from `null` to
`0`; this endpoint must not undo that from the other side. A zero detection
latency is a spectacular claim to make by accident — it says the system noticed
every stall instantly, when what happened is that nothing was measured.

Two of the six are computed today:

| Metric                 | Today        | Why                                                      |
| ---------------------- | ------------ | -------------------------------------------------------- |
| `detectionLatency`     | **computed** | p50 of `Escalation.detectLatencyMs` (#59), in seconds    |
| `attemptsPerWorkOrder` | **computed** | mean runs over work orders that reached `succeeded`      |
| `deadTimePerDay`       | `null`       | nothing records how long a run _spent_ stalled or parked |
| `firstPassAcceptance`  | `null`       | merge state is not tracked anywhere                      |
| `costPerMergedPr`      | `null`       | merge state is not tracked anywhere                      |
| `quotaBurn`            | `null`       | consumption against a window capacity is not recorded    |

Each `null` refuses a specific temptation. Dead time could be approximated from
currently-stalled runs — that answers _"dead time right now"_, not _"per day
across the window"_. Quota burn could be computed from the GitHub rate limit, but
VISION §11's shared quota is the agent subscription, and labelling one while
measuring the other is the same substitution in a better disguise.

`trend` is the sparkline series, **oldest first, with quiet days dropped**. The
array is `number[]` and cannot express a gap, so a zero would draw a latency
sparkline through the floor and claim a perfect day. A shorter array is the
honest representation; `Sparkline` draws nothing for zero or one point rather
than a flat line implying stability nobody measured.

```json
{
  "data": {
    "generatedAt": "2026-08-23T04:40:00.000Z",
    "window": {
      "from": "2026-08-16T04:40:00.000Z",
      "to": "2026-08-23T04:40:00.000Z"
    },
    "metrics": {
      "detectionLatency": { "value": 15, "trend": [5, 60] },
      "deadTimePerDay": { "value": null, "trend": [] },
      "firstPassAcceptance": { "value": null, "trend": [] },
      "attemptsPerWorkOrder": { "value": 3, "trend": [3] },
      "costPerMergedPr": { "value": null, "trend": [] },
      "quotaBurn": { "value": null, "trend": [] }
    }
  }
}
```

`generatedAt` is when the control plane computed the summary, not when the client
fetched it, so a panel showing a stale row can say how stale.

#### `GET /api/runs/{id}/events`

One run's normalized event timeline, newest first. Requires `runs:read`.

| Query               | Type   | Default    | Notes               |
| ------------------- | ------ | ---------- | ------------------- |
| `page` / `pageSize` | number | `1` / `50` | `pageSize` max 200. |

**Its own endpoint rather than an array on the run**, because `RunEvent` is
high-volume (#39): a single run emits a progress event per tool call plus
heartbeats, so an unpaginated timeline would not survive a real run. Making it a
separate route means the pagination cannot be forgotten.

Ordered `occurredAt` then `recordedAt`. The tiebreak is load-bearing: two events
can share a reported millisecond, and an unstable sort would shuffle them
between pages so a reader could see one twice and another never.

`type` uses the wire vocabulary — `run.started`, not the `run_started` the
database stores (Postgres cannot hold a dot in an enum label). `source` says
whether a runner reported the event, the git watcher derived it, or the control
plane synthesized it; VISION §9 requires that **a synthesized event never
masquerade as a report**, which is why it is a field rather than a note in the
summary text.

---

### Escalations

What needs a human. VISION §9 is explicit that **escalation is an action, not
telemetry** — a stalled run nobody is told about is the exact failure this
system exists to eliminate — so escalations get records, a lifecycle and their
own endpoints rather than a log line somebody might grep for.

Requires `escalations:read` to read and `escalations:acknowledge` to
acknowledge.

**Escalations are deduplicated per (run, kind).** The watchdog is a
reconciler: it re-derives the same verdict on every tick by design. Without
deduplication a one-minute tick would page sixty times an hour about one
stall, and an operator paged twelve times about the same thing stops reading
escalations — which reproduces the original problem by a different route.
Deduped per kind rather than per run, so a run that is both looping and over
budget still shows both.

`delivered` and `failed` count as **unresolved**: the operator was told and
has not acted. `acknowledged` and `resolved` do not, so a condition that
recurs after a human dealt with it raises again.

#### GET /escalations

List escalations, newest first. Paginated.

**Query parameters:**

| Parameter        | Type    | Default | Description                                                               |
| ---------------- | ------- | ------- | ------------------------------------------------------------------------- |
| `page`           | number  | `1`     | 1-based page number                                                       |
| `pageSize`       | number  | `25`    | Max 100                                                                   |
| `status`         | string  | —       | `raised`, `dispatched`, `delivered`, `failed`, `acknowledged`, `resolved` |
| `unresolvedOnly` | boolean | —       | The triage view                                                           |
| `runId`          | uuid    | —       | One run's escalations                                                     |

Each escalation carries its own latency measurement: `progressStoppedAt`,
`detectionSource`, `detectLatencyMs` and `notifyLatencyMs`.

#### GET /escalations/latency

Detection latency, aggregated. **VISION §10's success metric 1**, whose target
is _seconds_.

Measured **stop-to-notified**: from a run ceasing to make progress to a human
being informed. Measuring stop-to-_detected_ instead would report success
while the operator still finds out four hours later, so the two are separate
figures and only one of them is the metric.

**Query parameters:**

| Parameter    | Type      | Default | Description                         |
| ------------ | --------- | ------- | ----------------------------------- |
| `since`      | date-time | —       | Inclusive lower bound on `raisedAt` |
| `until`      | date-time | —       | Inclusive upper bound on `raisedAt` |
| `repository` | string    | —       | `owner/name`                        |

**Response:**

```json
{
  "since": "2026-08-15T00:00:00.000Z",
  "until": null,
  "truncated": false,
  "sampleSize": 42,
  "notified": {
    "count": 38,
    "p50Ms": 6200,
    "p90Ms": 11400,
    "p99Ms": 19800,
    "maxMs": 19800
  },
  "detected": {
    "count": 42,
    "p50Ms": 2100,
    "p90Ms": 4300,
    "p99Ms": 9100,
    "maxMs": 9100
  },
  "awaitingNotification": 4,
  "unmeasurable": 0,
  "bySource": {
    "runner": {
      "notified": {
        "count": 30,
        "p50Ms": 4100,
        "p90Ms": 8200,
        "p99Ms": 9100,
        "maxMs": 9100
      },
      "detected": {
        "count": 32,
        "p50Ms": 1800,
        "p90Ms": 3200,
        "p99Ms": 4000,
        "maxMs": 4000
      },
      "awaitingNotification": 2,
      "unmeasurable": 0
    },
    "git": {
      "notified": {
        "count": 8,
        "p50Ms": 14500,
        "p90Ms": 19800,
        "p99Ms": 19800,
        "maxMs": 19800
      },
      "detected": {
        "count": 10,
        "p50Ms": 7400,
        "p90Ms": 9100,
        "p99Ms": 9100,
        "maxMs": 9100
      },
      "awaitingNotification": 2,
      "unmeasurable": 0
    },
    "control_plane": {
      "notified": {
        "count": 0,
        "p50Ms": null,
        "p90Ms": null,
        "p99Ms": null,
        "maxMs": null
      },
      "detected": {
        "count": 0,
        "p50Ms": null,
        "p90Ms": null,
        "p99Ms": null,
        "maxMs": null
      },
      "awaitingNotification": 0,
      "unmeasurable": 0
    }
  }
}
```

Four figures, because three of them can hide the fourth:

| Field                  | Meaning                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notified`             | Stop to a human being informed. **The metric.**                                                                                                                                    |
| `detected`             | Stop to Opifex noticing. Reported alongside so the gap shows — a fast detector behind a broken transport looks perfect on this one alone.                                          |
| `awaitingNotification` | Measurable, raised, never delivered. Their real latency is unbounded; omitting them silently would make a totally broken transport render as excellent latency over a tiny sample. |
| `unmeasurable`         | No stop time at all, such as a `system` escalation. Counted rather than measured from `raisedAt`, which would add a zero-latency entry per unmeasurable event.                     |

Percentiles are **nearest-rank**, so every figure reported is one that
actually happened and the operator can go and find the run behind it. An empty
sample reports `null`, not `0` — zero milliseconds is an excellent latency,
and "we measured nothing" is not a latency at all.

`bySource` splits everything by liveness source. VISION §9 runs two
**independent** sources, and git-derived detection is structurally slower than
runner-reported; a blended number describes neither and hides which half needs
work.

`truncated` is `true` when the window held more escalations than one summary
reads. A truncation nobody reports reads as "this is what happened".

The same measurement is also exported over OpenTelemetry as
`opifex.detection.latency` and `opifex.detection.detect_latency`, with
`opifex.escalations.raised` and `opifex.escalations.notified` counters whose
gap is how many stalls nobody was told about. This endpoint does **not**
depend on the OTEL stack running — see
[ADR 0003](adr/0003-observability-backend.md).

#### POST /escalations/{id}/acknowledge

Record that a human has seen it — the one fact the lifecycle exists to
capture. Acknowledging twice is not an error; two people reaching for the same
page at once is normal and the first acknowledgement stands.

Acknowledging also re-arms the detector: the next occurrence raises a new
escalation, rather than being suppressed forever because somebody looked at
this one once.

**Errors:**

| Status | Cause              |
| ------ | ------------------ |
| `404`  | No such escalation |

---

### Notifications

Where an escalation actually reaches a person. VISION §1's original complaint
is a run that stalls at 10am and is discovered at 2pm; everything upstream can
work perfectly and detection latency is still measured in hours if nobody is
told.

**Web Push (RFC 8030) with VAPID**, chosen over ntfy and Pushover in
[ADR 0004](adr/0004-notification-transport.md) — no third-party account, no
per-vendor credential, and the payload is encrypted end to end so the push
service relays bytes it cannot read. That last point is what makes it
acceptable to put the escalation's real reason in the notification body rather
than a "something happened, open the app" stub.

Everything except the receipt endpoint requires only that you are signed in.
Managing your own phone is the same class of thing as managing your own
settings.

#### A push service accepting a message is not a phone ringing

This is why the escalation lifecycle has three statuses and not two:

| Status       | Means                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `dispatched` | A push service returned 201. It has taken custody. Nothing more is known.                        |
| `delivered`  | A device posted a receipt back. Somebody's phone rang.                                           |
| `failed`     | No transport would take it, **or** the receipt never arrived within `NOTIFY_RECEIPT_TIMEOUT_MS`. |

Collapsing the first two would put a green tick next to a notification nobody
saw — the exact failure #58 describes.

#### GET /notifications/config

What the browser needs in order to subscribe.

**Response:**

```json
{
  "vapidPublicKey": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZwuiKmpBpMWvcxYVbGGmkTBBUuRQGSlxAOKmR1IQ",
  "pushConfigured": true,
  "fallbackConfigured": false
}
```

`pushConfigured` is false when the server has no VAPID keys. The UI uses it to
say _"notifications are not set up on this server"_ rather than offering a
button that silently does nothing — which would be the same failure as no
notification at all, dressed as a feature.

#### GET /notifications/subscriptions

The current user's registered devices. **Never returns `p256dh` or `auth`** —
they are the device's payload-encryption secrets, the browser already has
them, and handing them back would turn a listing into a way to push arbitrary
content to somebody's phone.

#### POST /notifications/subscriptions

Register a device.

**Request:**

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "p256dh": "BN...",
  "auth": "k9...",
  "userAgent": "Mozilla/5.0 (iPhone...)"
}
```

**Idempotent on `endpoint`**, which _is_ the device's identity in the Web Push
protocol: a browser re-subscribing with the same key material gets the same
endpoint back, and a second row for it would push twice to one phone. The
upsert also clears the failure count — a browser that just handed over a fresh
subscription is, by construction, working again.

#### DELETE /notifications/subscriptions/{id}

Stop notifying a device. Returns `204`. Scoped to the caller, so one user
cannot remove another's device even by guessing an id.

#### POST /notifications/receipts

**Public.** The device confirming it actually displayed a notification.

```json
{ "receiptId": "9f2c...64 hex characters" }
```

The receipt token is the only credential, and that is deliberate: a service
worker has no session, and the alternatives were no receipts at all or storing
a bearer token somewhere a service worker can read it. A 32-byte random id that
arrives inside an end-to-end encrypted payload and grants exactly one thing —
marking one escalation delivered — is a strictly better credential than either.

An unknown token and an already-used one both return `404`, so the endpoint
cannot be used as an oracle for guessing tokens. It is never sent to the
fallback webhook: a third-party receiver is not the device and has no business
confirming a notification it cannot display.

This is what closes the stop-to-notified measurement in
`GET /escalations/latency`.

#### What arrives on the phone

VISION §8: _"one tap from a phone, with enough context to decide — what, why,
blast radius, and what happens if ignored."_ Those are four separate fields in
the payload, not prose, because prose is what gets trimmed when somebody writes
a notification in a hurry and the part that survives is the part that says
least.

Consequences are written per escalation kind. A stalled run is burning nothing
and simply not finishing; a looping one is spending money right now. One
generic sentence would have to be vague enough to cover both, and a
notification that cannot distinguish _"this can wait until morning"_ from
_"this is costing money"_ fails the only test that matters at 2am.

#### When delivery fails

A Web Push failure re-routes to `NOTIFY_FALLBACK_WEBHOOK_URL` if one is set — a
**different path, not a retry**, since if the push service is down or no device
is subscribed then sending again produces the same silence. The fallback is off
unless configured: it sends escalation text to a third party, which is the
operator's decision and not a default.

With no fallback configured, a failure ends at a `failed` escalation, an
`error`-level log line marked `NOTIFICATION FAILED`, and the cockpit's failed
list. The failure reason names which of three problems occurred — no VAPID
keys, no devices subscribed, or every device rejecting — because they have
three different fixes.

---

### Health

**Public endpoints** - Used for Kubernetes liveness/readiness probes.

#### GET /health

Full health check - includes database connectivity test. Equivalent to GET /health/ready.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**

- 503 Service Unavailable - Database connection failed

---

#### GET /health/live

Liveness check - always returns 200 if service is running.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

#### GET /health/ready

Readiness check - includes database connectivity test.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**

- 503 Service Unavailable - Database connection failed

---

## HTTP Status Codes

| Code | Description                                                                     |
| ---- | ------------------------------------------------------------------------------- |
| 200  | OK - Request successful                                                         |
| 201  | Created - Resource created successfully                                         |
| 204  | No Content - Request successful, no response body                               |
| 400  | Bad Request - Invalid request format or validation error                        |
| 401  | Unauthorized - Missing or invalid authentication token                          |
| 403  | Forbidden - Insufficient permissions or user disabled                           |
| 404  | Not Found - Resource not found                                                  |
| 409  | Conflict - Resource already exists or version mismatch (optimistic concurrency) |
| 500  | Internal Server Error - Server error occurred                                   |
| 503  | Service Unavailable - Service temporarily unavailable                           |

---

## Error Codes

| Code               | HTTP Status | Description                                       |
| ------------------ | ----------- | ------------------------------------------------- |
| `AUTH_REQUIRED`    | 401         | No valid authentication token provided            |
| `INVALID_TOKEN`    | 401         | JWT token is invalid or expired                   |
| `FORBIDDEN`        | 403         | User does not have required permissions           |
| `USER_DISABLED`    | 403         | User account is disabled                          |
| `NOT_FOUND`        | 404         | Requested resource not found                      |
| `VALIDATION_ERROR` | 400         | Request validation failed                         |
| `CONFLICT`         | 409         | Resource already exists or version mismatch       |
| `NOT_AUTHORIZED`   | 403         | Email not in allowlist                            |
| `VERSION_MISMATCH` | 409         | Optimistic concurrency conflict (If-Match header) |

---

## Rate Limits

> **Note:** Rate limiting is recommended for production deployments but is not currently implemented in the application. Consider adding `@nestjs/throttler` or Nginx rate limiting before production deployment.

**Recommended limits:**

| Endpoint Pattern                   | Recommended Limit | Window   |
| ---------------------------------- | ----------------- | -------- |
| `/api/auth/*`                      | 10 requests       | 1 minute |
| `/api/allowlist` (POST)            | 30 requests       | 1 minute |
| `/api/system-settings` (PUT/PATCH) | 30 requests       | 1 minute |
| All other endpoints                | 100 requests      | 1 minute |

---

## OpenAPI Documentation

Interactive API documentation with request/response examples is available at:

**Development:** http://localhost:3535/api/docs

This serves a [Scalar](https://scalar.com) reference page (not Swagger UI) generated from the
OpenAPI 3.1 document at `/api/openapi.json`. It allows you to:

- Explore all endpoints, grouped into sections via `x-tagGroups`
- View request/response schemas, including the generated **Requires:** RBAC line per operation
- Test API calls directly from the browser
- Authenticate with one click via "Authorize with my session" (exchanges your existing browser
  session for an access token), a personal access token, or a device authorization grant

See [`docs/specs/api-documentation.md`](specs/api-documentation.md) for how the document is built.

---

## CORS Policy

The API uses a **same-origin architecture**. Both the frontend and API are served from the same host (via Nginx reverse proxy):

- Frontend: `http://localhost:3535/`
- API: `http://localhost:3535/api`

This eliminates CORS complexity and improves security. No cross-origin requests are required.

---

## Security Headers

All API responses include security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Versioning

The API currently does not use versioning (v1, v2, etc.). Breaking changes will be avoided when possible. When breaking changes are necessary, they will be:

1. Announced in advance
2. Documented in migration guides
3. Implemented with a transition period when feasible

For future versions, the API may adopt URL-based versioning: `/api/v2/...`
