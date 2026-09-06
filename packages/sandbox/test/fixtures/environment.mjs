console.log(
  JSON.stringify({
    groqKey: process.env.GROQ_API_KEY ?? null,
    githubToken: process.env.GITHUB_TOKEN ?? null,
    safeValue: process.env.SAFE_VALUE ?? null,
  }),
);
