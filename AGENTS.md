# User Preferences

- When saving files or artifacts, use `/Users/ponpokotanuki/Desktop/codex` as the default destination unless the user specifies another path or the current project requires files to stay inside the repository.
- For code or configuration changes that affect this project, do not stop at local edits. Unless the user explicitly says not to, commit the completed changes to GitHub and deploy the production Vercel app, then verify both GitHub and Vercel are updated.
- When verifying production, use `https://kindle-price-watch.vercel.app/` and check the relevant API/UI behavior after deployment, not only the Vercel deploy command result.
