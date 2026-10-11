# 0005. Hotel-user authentication

Date: 2026-10-11 · Status: accepted

## Context
Hotel staff sign in to the dashboard. The spec fixes Amazon Cognito, with a dev provider behind the same interface for local work.

## Decision
- **Port:** `IdentityProvider.verify(token) → { subject, email, name } | null` (core). The API only ever sees bearer tokens.
- **Cognito:** the web app runs the OAuth 2.0 authorization-code flow with PKCE against the user pool's managed login (`/oauth2/authorize`, `/oauth2/token`, `/logout`). It stores the ID token in an httpOnly, SameSite=Lax cookie and the refresh token in a second cookie. `proxy.ts` refreshes the ID token shortly before expiry. The API verifies ID tokens against the pool's JWKS with `aws-jwt-verify` (`tokenUse: 'id'`, audience = app client) and requires `email_verified`.
- **Dev:** `POST /v1/auth/dev/login {email}` issues an HS256 token signed with `AUTH_DEV_SECRET`. It is registered only when `AUTH_PROVIDER=dev`, and production config refuses to start with it.
- **Users:** keyed by provider-qualified subject (`cognito:<sub>`, `dev:<email>`). The first sign-in creates the user. A verified email that matches an existing user re-links that account to the new subject, so moving from dev auth to Cognito keeps memberships.
- **Authorization:** membership roles (owner/admin/viewer) map to permissions in `packages/core/src/permissions.ts`. Every org route declares a permission. The router returns 404 to non-members, so org IDs can't be probed, and 403 for missing permissions. Services re-check with `assertCan`. A test sweeps every registered route for 401/404/403 behaviour.
- **Invitations:** a random 256-bit token is emailed and only its SHA-256 is stored. Invitations expire after 7 days and must be accepted by the invited address. Nobody can grant a role above their own.
- The web app calls the API from Server Components and Server Actions with the session token. The token never reaches browser JavaScript.

## Consequences
Cognito setup (user pool, app client with PKCE, managed login domain, callback URLs) is in CDK and SETUP-NEEDED.md. MFA and SSO federation are Cognito configuration, not code changes.
