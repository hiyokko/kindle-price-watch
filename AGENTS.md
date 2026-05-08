# User Preferences

- When saving files or artifacts, use `/Users/ponpokotanuki/Desktop/codex` as the default destination unless the user specifies another path or the current project requires files to stay inside the repository.
- For any change that affects this project, including code, configuration, documentation, and these instructions, do not stop at local edits. Even if the user does not give a separate deployment instruction, commit the completed changes to GitHub and deploy the production Vercel app unless the user explicitly says not to. Afterward, verify both GitHub and Vercel are updated.
- When verifying production, use `https://kindle-price-watch.vercel.app/` and check the relevant API/UI behavior after deployment, not only the Vercel deploy command result.
