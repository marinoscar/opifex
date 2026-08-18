# Device Authorization Flow (RFC 8628)

This module implements the OAuth 2.0 Device Authorization Grant (RFC 8628), enabling secure authentication for devices with limited input capabilities such as CLI tools, Swagger UI, smart TVs, and IoT devices.

## Overview

The Device Authorization Flow allows users to authorize devices on a separate device with better input/display capabilities (like a phone or computer). The flow works as follows:

1. Device requests authorization and receives a device code and user code
2. Device displays the user code and verification URL to the user
3. User navigates to the verification URL on another device and enters the user code
4. User authenticates (if not already) and approves the device
5. Device polls the token endpoint and receives access tokens once approved

## Architecture

### Files

```
device-auth/
├── dto/
│   ├── device-code-request.dto.ts        # Request for generating device codes
│   ├── device-code-response.dto.ts       # Response with device/user codes
│   ├── device-token-request.dto.ts       # Request for polling authorization
│   ├── device-token-response.dto.ts      # Response with JWT tokens
│   ├── device-token-error.dto.ts         # RFC 8628 error responses
│   ├── device-authorize-request.dto.ts   # Request to approve/deny device
│   ├── device-authorize-response.dto.ts  # Response for authorization action
│   ├── device-activate-response.dto.ts   # Response for activation page info
│   ├── device-session.dto.ts             # Device session management DTOs
│   └── index.ts
├── tasks/
│   └── device-code-cleanup.task.ts       # Scheduled cleanup of expired codes
├── device-auth.controller.ts             # REST API endpoints
├── device-auth.service.ts                # Business logic
├── device-auth.module.ts                 # NestJS module definition
└── README.md                             # This file
```

### Database Schema

The `device_codes` table stores device authorization requests:

```prisma
model DeviceCode {
  id         String           @id @default(uuid())
  deviceCode String           @unique @map("device_code")  // Hashed
  userCode   String           @unique @map("user_code")     // XXXX-XXXX format
  userId     String?          @map("user_id")
  status     DeviceCodeStatus @default(pending)
  clientInfo Json?            @map("client_info")
  scopes     String[]
  expiresAt  DateTime         @map("expires_at")
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt
}

enum DeviceCodeStatus {
  pending
  approved
  denied
  expired
}
```

## API Endpoints

### 1. POST /api/auth/activate/code (Public)

Generates a new device code pair to initiate the authorization flow.

**Request:**
```json
{
  "clientInfo": {
    "deviceName": "CLI Tool",
    "userAgent": "MyApp/1.0"
  }
}
```

**Response:**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/activate",
    "verificationUriComplete": "http://localhost:3535/activate?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

### 2. POST /api/auth/activate/token (Public)

Device polls this endpoint to check authorization status.

**Request:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (Success):**
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

**Response (Pending - 400):**
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

**Response (Rate Limited - 400):**
```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

**Other Error Codes:**
- `expired_token` - The device code has expired
- `access_denied` - User denied the authorization request

### 3. GET /api/auth/activate/activate (Authenticated)

Returns information for the device activation page.

**Query Parameters:**
- `code` (optional): User verification code (e.g., "ABCD-1234")

**Response (no code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate"
  }
}
```

**Response (with valid code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "deviceName": "CLI Tool"
    },
    "expiresAt": "2026-01-22T12:00:00Z"
  }
}
```

### 4. POST /api/auth/activate/authorize (Authenticated)

User approves or denies a device authorization request.

**Request:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

### 5. GET /api/auth/activate/sessions (Authenticated)

Lists the user's approved device sessions.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Page size (default: 10)

**Response:**
```json
{
  "data": {
    "sessions": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "deviceName": "CLI Tool"
        },
        "createdAt": "2026-01-22T10:30:00Z",
        "expiresAt": "2026-01-22T10:45:00Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 10
  }
}
```

### 6. DELETE /api/auth/activate/sessions/:id (Authenticated)

Revokes a specific device session.

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

## Configuration

Environment variables (added to `infra/compose/.env.example`):

```bash
# Device Authorization Flow (RFC 8628)
DEVICE_CODE_EXPIRY_MINUTES=15    # How long device codes are valid
DEVICE_CODE_POLL_INTERVAL=5      # Minimum seconds between polls
```

## Security Features

1. **Device Code Hashing**: Device codes are hashed before storage (SHA-256)
2. **User Code Format**: Human-friendly codes use unambiguous characters (no 0/O, 1/I/l)
3. **Rate Limiting**: Built-in polling rate limiting to prevent abuse
4. **Expiration**: Codes automatically expire after configured time
5. **One-time Use**: Approved codes are marked as expired after token generation
6. **User Verification**: Only authenticated users can approve devices

## User Code Generation

User codes are generated using a safe character set to avoid confusion:
- Characters: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- Format: `XXXX-XXXX` (e.g., `ABCD-1234`)
- Excludes: 0, O, 1, I, l (to prevent user confusion)

## Scheduled Tasks

### Device Code Cleanup

Runs daily at 2 AM to remove:
- Expired device codes
- Codes marked as expired more than 24 hours ago

## Integration Examples

### CLI Tool Example

```typescript
// 1. Request device code
const { deviceCode, userCode, verificationUri, interval } =
  await fetch('/api/auth/activate/code', { method: 'POST' }).then(r => r.json());

console.log(`Please visit ${verificationUri}`);
console.log(`Enter code: ${userCode}`);

// 2. Poll for authorization
while (true) {
  await sleep(interval * 1000);

  try {
    const tokens = await fetch('/api/auth/activate/token', {
      method: 'POST',
      body: JSON.stringify({ deviceCode })
    }).then(r => r.json());

    // Success! Store tokens
    console.log('Authorized!');
    break;
  } catch (error) {
    if (error.error === 'authorization_pending') {
      continue; // Keep polling
    }
    throw error;
  }
}
```

### Frontend Integration (Activation Page)

```typescript
// Device activation page at /activate
const searchParams = new URLSearchParams(window.location.search);
const code = searchParams.get('code');

// Fetch device info
const deviceInfo = await fetch(
  `/api/auth/activate/activate?code=${code}`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
).then(r => r.json());

// Display device info and approval UI
// On approve:
await fetch('/api/auth/activate/authorize', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({
    userCode: code,
    approve: true
  })
});
```

## Error Handling

The module follows RFC 8628 error codes for consistency:

| Error Code | Status | Description |
|------------|--------|-------------|
| `authorization_pending` | 400 | User hasn't authorized yet |
| `slow_down` | 400 | Polling too fast |
| `expired_token` | 400 | Device code expired |
| `access_denied` | 400 | User denied authorization |
| `invalid_grant` | 401 | Invalid device code |

## Testing

### Manual Testing

1. Generate a device code:
```bash
curl -X POST http://localhost:3535/api/auth/activate/code \
  -H "Content-Type: application/json" \
  -d '{"clientInfo": {"deviceName": "Test CLI"}}'
```

2. Visit the verification URL and enter the user code

3. Poll for tokens:
```bash
curl -X POST http://localhost:3535/api/auth/activate/token \
  -H "Content-Type: application/json" \
  -d '{"deviceCode": "YOUR_DEVICE_CODE"}'
```

## Future Enhancements

- [ ] Add scope-based permissions for device authorization
- [ ] Support for device-specific refresh token policies
- [ ] Device fingerprinting for enhanced security
- [ ] Geolocation tracking for device sessions
- [ ] Email notifications on new device authorizations
- [ ] Support for device names/descriptions in sessions UI
