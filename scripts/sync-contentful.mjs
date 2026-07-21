import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const environmentFile = await readFile(path.join(projectRoot, ".env"), "utf8");
  for (const line of environmentFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const spaceId = process.env.CONTENTFUL_SPACE_ID;
const accessToken = process.env.CONTENTFUL_DELIVERY_ACCESS_TOKEN;
const environment = process.env.CONTENTFUL_ENVIRONMENT ?? "master";

if (!spaceId || !accessToken) {
  throw new Error(
    "CONTENTFUL_SPACE_ID and CONTENTFUL_DELIVERY_ACCESS_TOKEN are required. Copy .env.example to .env and supply the delivery credentials.",
  );
}

const apiBase = `https://cdn.contentful.com/spaces/${spaceId}/environments/${environment}`;

async function fetchCollection(resource) {
  const items = [];
  let skip = 0;
  let total = Infinity;

  while (skip < total) {
    const url = new URL(`${apiBase}/${resource}`);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("skip", String(skip));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Contentful ${resource} request failed (${response.status}).`);
    }
    const payload = await response.json();
    items.push(...payload.items);
    total = payload.total;
    skip += payload.items.length;
    if (!payload.items.length) break;
  }

  return items;
}

const [entries, assets] = await Promise.all([
  fetchCollection("entries"),
  fetchCollection("assets"),
]);

const entriesById = new Map(entries.map((entry) => [entry.sys.id, entry]));
const assetsById = new Map(assets.map((asset) => [asset.sys.id, asset]));
const entriesByType = new Map();

for (const entry of entries) {
  const type = entry.sys.contentType.sys.id;
  const list = entriesByType.get(type) ?? [];
  list.push(entry);
  entriesByType.set(type, list);
}

const field = (entry, key) => entry?.fields?.[key];
const refId = (reference) => reference?.sys?.id;
const linkedEntry = (reference) => entriesById.get(refId(reference));
const linkedEntries = (references) => (references ?? []).map(linkedEntry).filter(Boolean);
const idFields = (entry) => ({ id: entry.sys.id, contentful_id: entry.sys.id });

function asset(reference) {
  const item = assetsById.get(refId(reference));
  if (!item) return undefined;
  const url = field(item, "file")?.url;
  return {
    url: url?.startsWith("//") ? `https:${url}` : url,
    title: field(item, "title") ?? field(item, "description") ?? "",
  };
}

function markdown(value) {
  if (!value) return undefined;
  const html = marked.parse(value, { gfm: true });
  return {
    childMarkdownRemark: {
      rawMarkdownBody: value,
      html,
    },
  };
}

function articleSummary(entry) {
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
  };
}

function subtopic(entry, includeRelations = true) {
  if (!entry) return undefined;
  const result = {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    description: field(entry, "description"),
    containsSequencedArticles: field(entry, "containsSequencedArticles"),
    articles: linkedEntries(field(entry, "articles")).map(articleSummary),
  };
  if (includeRelations) {
    const parent = topicForSubtopic.get(entry.sys.id);
    result.topic = parent ? [topic(parent, false)] : [];
  }
  return result;
}

function topic(entry, includeRelations = true) {
  if (!entry) return undefined;
  const result = {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    description: field(entry, "description"),
    subtopics: linkedEntries(field(entry, "subtopics")).map((item) => subtopic(item, false)),
  };
  if (includeRelations) {
    const parent = categoryForTopic.get(entry.sys.id);
    result.category = parent ? [category(parent, false)] : [];
  }
  return result;
}

function category(entry, includeRelations = true) {
  if (!entry) return undefined;
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    description: field(entry, "description"),
    isFeatured: field(entry, "isFeatured"),
    topics: includeRelations
      ? linkedEntries(field(entry, "topics")).map((item) => topic(item, false))
      : undefined,
  };
}

function helpArticle(entry) {
  const parent = subtopicForArticle.get(entry.sys.id);
  return {
    ...articleSummary(entry),
    description: markdown(field(entry, "description")),
    article: markdown(field(entry, "article")),
    relatedArticles: linkedEntries(field(entry, "relatedArticles")).map(articleSummary),
    subtopic: parent ? [subtopic(parent, true)] : [],
    isFeatured: field(entry, "isFeatured"),
    requiresAuthenticationToView: Boolean(field(entry, "requiresAuthenticationToView")),
  };
}

function academyLesson(entry) {
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    estimatedMinutesToComplete: field(entry, "estimatedMinutesToComplete"),
    videoLink: field(entry, "videoLink"),
    seoDescription: markdown(field(entry, "seoDescription")),
    content: markdown(field(entry, "content")),
    requiresAuthenticationToView: Boolean(field(entry, "requiresAuthenticationToView")),
  };
}

function academyCourse(entry) {
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    icon: asset(field(entry, "icon")),
    description: markdown(field(entry, "description")),
    lessons: linkedEntries(field(entry, "lessons")).map(academyLesson),
  };
}

function podcastEpisode(entry) {
  const parent = podcastSeriesForEpisode.get(entry.sys.id);
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    episodeLink: field(entry, "episodeLink") ?? field(entry, "youtubeUrl"),
    seoDescription: markdown(field(entry, "seoDescription")),
    description: markdown(field(entry, "description")),
    thumbnail: asset(field(entry, "thumbnail")),
    podcast_series: parent
      ? [{
          ...idFields(parent),
          title: field(parent, "title"),
          podcastEpisodes: linkedEntries(field(parent, "podcastEpisodes")).map(articleSummary),
        }]
      : [],
  };
}

function podcastSeries(entry) {
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    description: field(entry, "description"),
    slug: field(entry, "slug"),
    sortIndex: field(entry, "sortIndex"),
    podcastEpisodes: linkedEntries(field(entry, "podcastEpisodes")).map(podcastEpisode),
  };
}

function communityEvent(entry) {
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    date: field(entry, "date"),
    videoLink: field(entry, "videoLink"),
    thumbnail: asset(field(entry, "thumbnail")),
    eventImage: asset(field(entry, "eventImage")),
    seoDescription: markdown(field(entry, "seoDescription")),
    description: markdown(field(entry, "description")),
    requiresAuthenticationToView: Boolean(field(entry, "requiresAuthenticationToView")),
  };
}

function locale(entry) {
  return entry
    ? { code: field(entry, "code"), languageName: field(entry, "languageName") }
    : undefined;
}

function enterpriseArticle(entry) {
  const customer = enterpriseCustomerForArticle.get(entry.sys.id);
  return {
    ...idFields(entry),
    title: field(entry, "title"),
    slug: field(entry, "slug"),
    locale: locale(linkedEntry(field(entry, "locale"))),
    description: markdown(field(entry, "description")),
    coverImage: asset(field(entry, "coverImage")),
    article: markdown(field(entry, "article")),
    relatedArticles: linkedEntries(field(entry, "relatedArticles")).map(articleSummary),
    enterprise_customer: customer
      ? [{
          ...idFields(customer),
          name: field(customer, "name"),
          slug: field(customer, "slug"),
          description: markdown(field(customer, "description")),
          enterpriseEndUserArticles: linkedEntries(field(customer, "enterpriseEndUserArticles")).map(articleSummary),
        }]
      : [],
  };
}

const categoryForTopic = new Map();
const topicForSubtopic = new Map();
const subtopicForArticle = new Map();
const podcastSeriesForEpisode = new Map();
const enterpriseCustomerForArticle = new Map();

for (const entry of entriesByType.get("category") ?? []) {
  for (const child of linkedEntries(field(entry, "topics"))) categoryForTopic.set(child.sys.id, entry);
}
for (const entry of entriesByType.get("topic") ?? []) {
  for (const child of linkedEntries(field(entry, "subtopics"))) topicForSubtopic.set(child.sys.id, entry);
}
for (const entry of entriesByType.get("subtopic") ?? []) {
  for (const child of linkedEntries(field(entry, "articles"))) subtopicForArticle.set(child.sys.id, entry);
}
for (const entry of entriesByType.get("podcastSeries") ?? []) {
  for (const child of linkedEntries(field(entry, "podcastEpisodes"))) podcastSeriesForEpisode.set(child.sys.id, entry);
}
for (const entry of entriesByType.get("enterpriseCustomer") ?? []) {
  for (const child of linkedEntries(field(entry, "enterpriseEndUserArticles"))) enterpriseCustomerForArticle.set(child.sys.id, entry);
}

const pages = [
  { path: "/", kind: "home", context: {}, data: {} },
  { path: "/404/", kind: "notFound", context: {}, data: {} },
  { path: "/search_results/", kind: "search", context: {}, data: {} },
];

const allCategoriesList = (entriesByType.get("categoryList") ?? []).find(
  (entry) => field(entry, "internalName") === "All Categories",
);
const allCategories = linkedEntries(field(allCategoriesList, "categories"));

for (const categoryEntry of allCategories) {
  const categoryData = category(categoryEntry, true);
  pages.push({ path: `/${categoryData.slug}/`, kind: "category", context: { contentfulCategory: categoryData }, data: {} });
  for (const topicEntry of linkedEntries(field(categoryEntry, "topics"))) {
    const topicData = topic(topicEntry, false);
    pages.push({ path: `/${categoryData.slug}/${topicData.slug}/`, kind: "topic", context: { contentfulCategory: category(categoryEntry, false), contentfulTopic: topicData }, data: {} });
    for (const subtopicEntry of linkedEntries(field(topicEntry, "subtopics"))) {
      const subtopicData = subtopic(subtopicEntry, false);
      pages.push({ path: `/${categoryData.slug}/${topicData.slug}/${subtopicData.slug}/`, kind: "subtopic", context: { contentfulCategory: category(categoryEntry, false), contentfulTopic: topic(topicEntry, false), contentfulSubtopic: subtopicData }, data: {} });
    }
  }
}

const helpArticles = entriesByType.get("helpCenterArticle") ?? [];
for (const entry of helpArticles) {
  const item = helpArticle(entry);
  pages.push({ path: `/articles/${entry.sys.id}/`, kind: "article", context: { contentfulHelpCenterArticle: item }, data: {} });
}

pages.push({
  path: "/articles/",
  kind: "articles",
  context: {},
  data: {
    featuredArticles: { nodes: helpArticles.filter((entry) => field(entry, "isFeatured")).map(articleSummary) },
    featuredCategories: { nodes: (entriesByType.get("category") ?? []).filter((entry) => field(entry, "isFeatured")).map((entry) => category(entry, false)) },
  },
});

const allCoursesList = (entriesByType.get("academyCourseList") ?? []).find(
  (entry) => field(entry, "internalName") === "All Academy Courses",
);
const courses = linkedEntries(field(allCoursesList, "academyCourses"));
pages.push({ path: "/academy/", kind: "academy", context: {}, data: { allContentfulAcademyCourseList: { nodes: [{ academyCourses: courses.map(academyCourse) }] } } });
for (const courseEntry of courses) {
  const courseData = academyCourse(courseEntry);
  courseData.lessons.forEach((lessonData, index) => {
    const page = { kind: "academyLesson", context: { contentfulAcademyCourse: courseData, contentfulAcademyLesson: lessonData }, data: {} };
    pages.push({ ...page, path: `/academy/${courseData.slug}/lesson-${index + 1}/` });
    if (index === 0) pages.push({ ...page, path: `/academy/${courseData.slug}/` });
  });
}

const series = (entriesByType.get("podcastSeries") ?? []).map(podcastSeries).sort((a, b) => (b.sortIndex ?? 0) - (a.sortIndex ?? 0));
const events = (entriesByType.get("communityEvent") ?? []).map(communityEvent);
pages.push({ path: "/community/", kind: "community", context: {}, data: { podcastSeries: { nodes: series }, communityEvents: { nodes: events } } });
for (const entry of entriesByType.get("podcastEpisode") ?? []) {
  pages.push({ path: `/podcasts/${entry.sys.id}/`, kind: "podcast", context: { contentfulPodcastEpisode: podcastEpisode(entry) }, data: {} });
}
for (const entry of entriesByType.get("communityEvent") ?? []) {
  pages.push({ path: `/events/${entry.sys.id}/`, kind: "event", context: { contentfulCommunityEvent: communityEvent(entry) }, data: {} });
}

for (const entry of entriesByType.get("enterpriseEndUserArticle") ?? []) {
  const item = enterpriseArticle(entry);
  const customer = item.enterprise_customer[0];
  if (!item.locale?.code || !customer?.slug || !item.slug) continue;
  pages.push({ path: `/${item.locale.code}/end-users/${customer.slug}/${item.slug}/`, kind: "endUserArticle", context: { contentfulEnterpriseEndUserArticle: item }, data: {} });
  if (item.locale.code === "en-US") {
    pages.push({ path: `/end-users/${customer.slug}/${item.slug}/`, kind: "endUserArticle", context: { contentfulEnterpriseEndUserArticle: item }, data: {} });
  }
}

const uniquePages = [...new Map(pages.map((page) => [page.path, page])).values()]
  .sort((a, b) => a.path.localeCompare(b.path));
const searchIndex = uniquePages
  .filter((page) => !["home", "search", "notFound"].includes(page.kind))
  .map((page) => {
    const entity = Object.values(page.context)[0];
    const description = entity?.description?.childMarkdownRemark?.rawMarkdownBody ?? entity?.seoDescription?.childMarkdownRemark?.rawMarkdownBody ?? (typeof entity?.description === "string" ? entity.description : "");
    const title = entity?.title ?? (page.kind === "articles" ? "Articles" : page.kind === "academy" ? "Persona Academy" : page.kind === "community" ? "Persona Community" : "Persona Help Center");
    return { path: page.path, title, description, kind: page.kind };
  });

await mkdir(path.join(projectRoot, "src/data"), { recursive: true });
await writeFile(path.join(projectRoot, "src/data/pages.json"), JSON.stringify(uniquePages));
await writeFile(path.join(projectRoot, "public/search-index.json"), JSON.stringify(searchIndex));

console.log(`Synced ${entries.length} Contentful entries into ${uniquePages.length} Astro routes.`);
