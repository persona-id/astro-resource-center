export type ResourcePageKind =
  | "home"
  | "articles"
  | "academy"
  | "community"
  | "search"
  | "category"
  | "topic"
  | "subtopic"
  | "article"
  | "podcast"
  | "event"
  | "academyLesson"
  | "endUserArticle"
  | "notFound";

export interface ResourcePage {
  path: string;
  kind: ResourcePageKind;
  context: Record<string, any>;
  data: Record<string, any>;
}
