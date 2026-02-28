---
name: reload-callboard
description: Install dependencies, build, package, and restart Callboard production. Stop immediately if any step fails.
---

## Steps

1. **Install dev dependencies**:

   ```
   npm install --include=dev
   ```

   Stop and fix any installation errors before continuing.

2. **Build** the project:

   ```
   npm run build
   ```

   Stop and fix any build errors before continuing.

3. **Package and install globally**:

   Read the version from `package.json` to construct the tarball filename:

   ```
   npm pack --pack-destination /tmp
   ```

   ```
   npm install -g /tmp/wolpertingerlabs-callboard-<version>.tgz && rm /tmp/wolpertingerlabs-callboard-<version>.tgz
   ```

   (Replace `<version>` with the actual version from package.json, e.g. `1.0.0-alpha.1`)

4. **Restart production**:

   ```
   callboard restart
   ```

   Confirm the server is running:

   ```
   callboard status
   ```

## Important

- If any step fails, **stop immediately**, diagnose the issue, fix it, and restart from the failed step.
- After the final step, confirm production is running with `callboard status`.
