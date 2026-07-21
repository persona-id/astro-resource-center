# Persona Help Center (Astro)

This project is the Astro migration of the Persona Help Center. Contentful remains the source of truth: every development and production build fetches the current published entries from the Contentful Delivery API and generates the Astro route graph.

## Configuration

Copy `.env.example` to `.env` and set:

- `CONTENTFUL_SPACE_ID`
- `CONTENTFUL_DELIVERY_ACCESS_TOKEN`
- `CONTENTFUL_ENVIRONMENT` (defaults to `master`)
- `PUBLIC_PERSONA_HOSTNAME` for Dashboard links and authenticated article checks

No Contentful credentials are committed.

## Local development

```sh
npm install
npm run dev
```

The `predev` hook runs `npm run contentful:sync`, which fetches categories, topics, subtopics, articles, academy courses, podcasts, events, assets, locales, and enterprise end-user content. Generated data is ignored by Git.

## Production

```sh
npm run build
npm run deploy
```

The `prebuild` hook refreshes Contentful before Astro generates the static site and packages it for Cloudflare Workers.
