# User Preferences

- When saving files or artifacts, use `/Users/ponpokotanuki/Desktop/codex` as the default destination unless the user specifies another path or the current project requires files to stay inside the repository.
- For any change that affects this project, including code, configuration, documentation, and these instructions, do not stop at local edits. Even if the user does not give a separate deployment instruction, commit the completed changes to GitHub and deploy the production Vercel app unless the user explicitly says not to. Afterward, verify both GitHub and Vercel are updated.
- When updating this project, keep every related copy or target in sync: local files in this repository, the GitHub `main` branch, and the production Vercel deployment. Do not treat a change as complete while any applicable local, GitHub, or Vercel target is still stale.
- When verifying production, use `https://kindle-price-watch.vercel.app/` and check the relevant API/UI behavior after deployment, not only the Vercel deploy command result.
