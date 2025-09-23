# Repository Guidelines

## Project Structure & Module Organization
- `functions/src`: TypeScript sources for Firebase Cloud Functions; main entry is `index.ts`.
- `functions/lib`: Generated JavaScript output; do not edit.
- `firebase.json`, `firestore.rules`, `firestore.indexes.json`: Deployment and security configuration.
- `spec/`: Functional reference material.
- `README.md`: Deployment quickstart; update when CLI steps change.

## Build, Test, and Development Commands
- `cd functions && npm install`: install dependencies.
- `npm run build`: compile TypeScript to `lib/`.
- `npm run build:watch`: incremental compilation while coding.
- `npm run serve`: build then launch the local function emulator.
- `npm run shell`: open an interactive function shell.
- `npm run deploy`: push the current build to Firebase.
- `npm run lint`: run ESLint on TypeScript and JavaScript sources.

## Coding Style & Naming Conventions
- ESLint extends the Google style guide; use 2-space indentation and double quotes (`"example"`).
- Keep modules in `functions/src`, using strict TypeScript and NodeNext module resolution.
- Use camelCase for variables/functions, PascalCase for classes, and descriptive filenames like `callTranscription.ts`.
- Share cross-cutting logic via `functions/src/utils/`; never import from `lib/`.

## Testing Guidelines
- Use `firebase-functions-test` for unit and integration coverage; place specs in `functions/src/__tests__/`.
- Name tests `<feature>.test.ts` to mirror the source under test.
- Validate rule-sensitive flows through the emulator with `npm run serve` before deploying.
- Add an `npm test` script when adopting a runner (e.g., Jest) and refresh this guide.

## Commit & Pull Request Guidelines
- Git history is unavailable here; follow Conventional Commits (`feat:`, `fix:`, `chore:`) for consistency.
- Keep commits focused and reference folder scopes when helpful (`feat(functions): add call webhook`).
- Pull requests need a summary, testing notes (`npm run lint`, `npm run serve`), linked issues, and emulator evidence for behavior changes.

## Security & Configuration Tips
- Keep secrets out of source; manage them with `firebase functions:config:set` and verify via `firebase functions:config:get`.
- Review `firestore.rules` changes in the emulator before deployment and describe permission updates in PRs.
- Confirm `.firebaserc` project aliases with `firebase use` before running `npm run deploy`.
