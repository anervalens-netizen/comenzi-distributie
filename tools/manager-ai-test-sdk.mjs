// Bundled fixtures live in tmpfs or data URLs. Load the installed SDK as Node ESM
// so its conditional exports and CommonJS dependencies match the application.
export const managerAiTestSdk = {
  name: 'manager-ai-installed-sdk',
  setup(build) {
    build.onResolve(
      { filter: /^(@openai\/agents(?:-(core|openai))?|openai)$/ },
      ({ path }) => ({ path: import.meta.resolve(path), external: true }),
    );
  },
};
