# SpeakFlow Firebase Project Spec

This document outlines the Firebase backend required to support the SpeakFlow MVP. It focuses on Firestore collections, Cloud Functions, security posture, and operational practices.

---

## 1. Project Overview

- **Suggested Firebase project ID:** `speakflow`
- **Primary region:** `eur3` (multi-region, low latency for EU-based users)
- **Products in scope:**
  - Cloud Firestore (Native mode)
  - Cloud Functions for Firebase (Node.js 20 runtime)
  - Secret Manager (for API keys)
  - Firebase Authentication (anonymous sign-in for all clients)
  - App Check (enable once the iOS app integrates)

The iOS client is the only consumer. All privileged actions happen through Cloud Functions so that Firestore access can remain read-only or fully restricted from the client. Every session must bootstrap Firebase Authentication anonymous sign-in before calling callable functions.

---

## 2. Firestore Data Model

All timestamps use Firestore `Timestamp`. Strings are UTF-8; numbers are stored as integers where possible. Unless noted otherwise, documents are immutable to clients.

### 2.1 Collections

#### `lessonTemplates`
Static catalog the app displays.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | ✅ | Display name (localized ID eventually). |
| `subtitle` | string | ✅ | Short teaser shown under the title. |
| `category` | string | ✅ | Category slug (`"Foundations"`, `"Work"`, etc.). |
| `estimatedDurationSeconds` | number | ✅ | Practice time hint (e.g., 240). |
| `isLocked` | boolean | ✅ | `true` if paywalled. |
| `requiredPersonalizationFields` | array<string> | ✅ | Maps to app enum (`user_name`, `user_city`, ...). |
| `promptTemplateId` | string | ✅ | FK into `promptTemplates`. |
| `localeOverrides` | map<string, map> | ❌ | Locale code → override metadata (`{ title, subtitle }`). |
| `createdAt` / `updatedAt` | timestamp | ✅ | Audit fields. |

**Document ID:** deterministic slug (e.g., `introduce-yourself`).

#### `promptTemplates`
Reusable prompt bodies + generation options.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | number | ✅ | Increment when content tweaks. |
| `model` | string | ✅ | LLM identifier (`gpt-4o-mini`, etc.). |
| `systemPrompt` | string | ✅ | System instruction. |
| `userPrompt` | string | ✅ | Template with `{{placeholders}}`. |
| `chunkingStrategy` | map | ✅ | e.g., `{ "type": "sentence", "maxLength": 140 }`. |
| `postProcessRules` | map | ❌ | Keyword filters, tone adjustments. |
| `temperature` | number | ❌ | Defaults to 0.8 if omitted. |
| `maxTokens` | number | ❌ | Safety cap. |
| `createdAt` / `updatedAt` | timestamp | ✅ |

**Document ID:** semantic or auto-ID (e.g., `self-intro-v1`).

#### `scriptCache`
Short-lived cache to avoid repeated LLM calls for identical inputs.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `userId` | string | ✅ | Firebase Auth UID (anonymous provider). |
| `lessonId` | string | ✅ | Matches lesson slug. |
| `personalizationHash` | string | ✅ | SHA256 of personalization payload + level + locale. |
| `script` | map | ✅ | `{ title, fullText, chunks [] }`. |
| `languageCode` | string | ✅ | e.g., `en-US`. |
| `chunks` | array<map> | ✅ | Denormalized for quick reads. |
| `createdAt` | timestamp | ✅ |
| `expiresAt` | timestamp | ✅ | TTL (default 7 days). |

**Document ID:** `${userId}_${lessonId}_${personalizationHash}`.

#### `users` *(future, optional)*
Only required if we store durable preferences beyond anonymous sessions. Keeps personalization defaults and preferences.

| Field | Type | Notes |
| --- | --- | --- |
| `personalization` | map<string,string> | Stores user-provided data. |
| `preferences` | map | e.g., selected language/level. |
| `createdAt` / `updatedAt` | timestamp | Audit fields. |

---

## 3. Cloud Functions

### 3.1 Technology
- Node.js 20 runtime
- TypeScript source in `functions/src`
- Deployed with `firebase deploy --only functions`
- Secrets pulled via `functions.config()` or Secret Manager bindings

### 3.2 HTTPS Callable Functions

All callable functions must validate `context.auth?.uid`; reject requests without anonymous auth.

#### `lessons-list`
- **Signature:** `functions.https.onCall`
- **Auth:** Required; anonymous Firebase Auth UID plus App Check header when available.
- **Request:** Empty payload.
- **Response:** `{ lessons: [...] }` matching the app’s `LessonTemplate` model.
- **Behaviour:**
  1. Ensure `context.auth` exists; otherwise throw `unauthenticated`.
  2. Fetch all documents from `lessonTemplates`.
  3. Sort by `category`, then `title`.
  4. Cache in-memory for 5 minutes to reduce Firestore reads.

#### `generate-script`
- **Signature:** `functions.https.onCall`
- **Auth:** Required; use `context.auth.uid` as cache key component.
- **Request:**
  ```json
  {
    "lessonId": "introduce-yourself",
    "languageCode": "en-US",
    "targetLevel": "B1",
    "personalization": {
      "user_name": "Alex",
      "user_city": "Berlin"
    }
  }
  ```
- **Response:**
  ```json
  {
    "lessonId": "introduce-yourself",
    "title": "Introduce Yourself",
    "chunks": [
      { "order": 0, "text": "Hi, I'm Alex." },
      { "order": 1, "text": "I live in Berlin and work as a product designer." }
    ],
    "fullText": "Hi, I'm Alex. I live in Berlin and work as a product designer."
  }
  ```
- **Flow:**
  1. Validate payload. Ensure personalization covers all required fields (drawn from `lessonTemplates`).
  2. Compute cache key using lesson, personalization hash, language, level, and `context.auth.uid`.
  3. Lookup `scriptCache`. If fresh entry exists, return it.
  4. Fetch lesson + prompt documents.
  5. Render prompt via Mustache or equivalent templater.
  6. Call OpenAI (model from prompt doc) using secret `OPENAI_API_KEY`.
  7. Parse response, run chunking rules, sanitize output.
  8. Persist to `scriptCache` with `expiresAt` (7 days default) and return.
  9. Log metrics (cache hit/miss, token usage) to Cloud Logging.

### 3.3 Scheduled Functions

#### `cleanup-expired-cache`
- **Trigger:** Pub/Sub schedule (`every 24 hours`).
- **Purpose:** Remove cache entries with `expiresAt < now`.
- **Batching:** Delete in batches of ≤200 docs per iteration.
- **Config:** `runWith({ memory: "256MB", timeoutSeconds: 540 })`.

### 3.4 Optional Future Functions
- `onUserDelete`: Firestore trigger to purge `/scriptCache` and `/users/{uid}` when an account is removed.
- `update-lesson-metadata`: Callable admin function gated behind IAM to edit lesson catalog.

---

## 4. Security Rules (Draft)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }

    match /lessonTemplates/{lessonId} {
      allow read: if isSignedIn();
      allow write: if false; // manage via tooling
    }

    match /promptTemplates/{promptId} {
      allow read, write: if false;
    }

    match /scriptCache/{cacheId} {
      allow get, delete: if isSignedIn() && request.auth.uid == resource.data.userId;
      allow create: if isSignedIn() && request.auth.uid == request.resource.data.userId;
      allow list: if false;
    }
  }
}
```

All client access flows through callable functions, which enforce anonymous authentication and App Check. Keep direct Firestore access disabled until additional rules are modeled.

---

## 5. Authentication Configuration

1. Enable Firebase Authentication → Anonymous provider in the console.
2. Require the iOS client to call `Auth.auth().signInAnonymously()` before invoking Cloud Functions.
3. Propagate the returned UID to analytics or personalization (no PII stored without consent).
4. For local work, run `firebase emulators:start --only auth,functions,firestore` and seed anonymous users if needed using the Auth emulator UI.

---

## 6. Secrets & Configuration

| Key | Storage | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Secret Manager | LLM billing credentials. |
| `AMPLITUDE_API_KEY` | Secret Manager (future) | Server-side analytics (optional). |
| `CACHE_TTL_SECONDS` | Runtime config (`functions.config().cache.ttl`) | Overrides default 604800 seconds.

### Local Development
1. `firebase emulators:start --only auth,functions,firestore`
2. Mock OpenAI by setting env `MOCK_SCRIPT=true` and returning a canned payload.
3. Use `.runtimeconfig.json` for local secrets (never commit).
4. In the Auth emulator, create anonymous sessions via UI or API before testing callable functions.

---

## 7. Deployment Checklist

1. `firebase login`
2. `cd functions && npm install`
3. `npm run build`
4. `firebase deploy --only functions`
5. Verify Cloud Logging for errors; confirm anonymous auth usage metrics and App Check enforcement once the client is ready.

---

## 8. Roadmap Enhancements

- **Progress Sync:** Add `/users/{uid}/progress/{lessonId}` to persist completion state.
- **Prompt Experiments:** Create `experiments` collection mapping cohorts to prompt versions.
- **Moderation:** Leverage OpenAI Moderation API or bespoke filters before returning generated text.
- **Analytics:** Stream function logs/metrics to BigQuery or Amplitude for cohort analysis.
- **Account Upgrade Path:** Provide linking from anonymous UID to email/Apple login to retain progress across devices.

---

_Updated: 2025-09-24_
