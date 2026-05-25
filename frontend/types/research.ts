export type UncertaintyType =
  | "problem_understanding"
  | "behavior_why"
  | "solution_uncertainty"
  | "usability"
  | "comparison"
  | "scale"
  | "other";

export type PreliminaryMethod =
  | "deep_interviews"
  | "concept_test"
  | "usability_testing"
  | "ab_test"
  | "survey"
  | "other";

export type AvailableSource =
  | "analytics"
  | "past_research"
  | "user_access"
  | "prototype"
  | "product"
  | "support_tickets"
  | "nothing";

export type ConstraintType =
  | "time_limited"
  | "budget_limited"
  | "hard_recruiting"
  | "no_user_contact"
  | "no_analytics";

export type Platform = "mobile_app" | "website" | "mobile_website" | "none";

export interface DiagnosticAnswers {
  decision: string;
  uncertainty_types: UncertaintyType[];
  custom_uncertainty?: string;
  preliminary_methods: PreliminaryMethod[];
  available_sources: AvailableSource[];
  custom_sources?: string;
  constraints: ConstraintType[];
  custom_constraints?: string;
  platform: Platform;
}

export interface Diagnosis extends DiagnosticAnswers {
  summary: string;
  research_goal: string;
  research_tasks: string[];
  needed_for_quality: string[];
  main_risks: string[];
}

export function uncertaintiesToMethods(types: UncertaintyType[]): PreliminaryMethod[] {
  return Array.from(new Set(types.map((t) => UNCERTAINTY_TO_METHOD[t])));
}

export const UNCERTAINTY_OPTIONS: { type: UncertaintyType; label: string }[] = [
  { type: "problem_understanding", label: "Не понимаем проблему пользователей" },
  { type: "behavior_why",          label: "Не понимаем причины поведения" },
  { type: "solution_uncertainty",  label: "Не уверены в решении" },
  { type: "usability",             label: "Проверяем удобство использования" },
  { type: "comparison",            label: "Сравниваем варианты" },
  { type: "scale",                 label: "Не понимаем масштаб проблемы" },
  { type: "other",                 label: "Другое" },
];

export const UNCERTAINTY_TO_METHOD: Record<UncertaintyType, PreliminaryMethod> = {
  problem_understanding: "deep_interviews",
  behavior_why:          "deep_interviews",
  solution_uncertainty:  "concept_test",
  usability:             "usability_testing",
  comparison:            "ab_test",
  scale:                 "survey",
  other:                 "other",
};

export const METHOD_LABELS: Record<PreliminaryMethod, string> = {
  deep_interviews:   "Глубинные интервью",
  concept_test:      "Concept test / Co-creation",
  usability_testing: "Юзабилити-тестирование",
  ab_test:           "A/B тест / Card sorting",
  survey:            "Опрос / Аналитика",
  other:             "Определим позже",
};

export const SOURCE_OPTIONS: { type: AvailableSource; label: string }[] = [
  { type: "analytics",       label: "Аналитика" },
  { type: "past_research",   label: "Прошлые исследования" },
  { type: "user_access",     label: "Доступ к пользователям" },
  { type: "prototype",       label: "Прототип" },
  { type: "product",         label: "Готовый продукт" },
  { type: "support_tickets", label: "Тикеты поддержки" },
  { type: "nothing",         label: "Ничего нет" },
];

export const SOURCE_LABELS: Record<AvailableSource, string> = {
  analytics:       "Аналитика",
  past_research:   "Прошлые исследования",
  user_access:     "Доступ к пользователям",
  prototype:       "Прототип",
  product:         "Готовый продукт",
  support_tickets: "Тикеты поддержки",
  nothing:         "Ничего нет",
};

export const CONSTRAINT_OPTIONS: { type: ConstraintType; label: string }[] = [
  { type: "time_limited",    label: "Мало времени" },
  { type: "budget_limited",  label: "Маленький бюджет" },
  { type: "hard_recruiting", label: "Сложный рекрутинг" },
  { type: "no_user_contact", label: "Нельзя общаться с пользователями" },
  { type: "no_analytics",    label: "Нет доступа к аналитике" },
];

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  time_limited:      "Мало времени",
  budget_limited:    "Маленький бюджет",
  hard_recruiting:   "Сложный рекрутинг",
  no_user_contact:   "Нельзя общаться с пользователями",
  no_analytics:      "Нет доступа к аналитике",
};

export const PLATFORM_OPTIONS: { type: Platform; label: string }[] = [
  { type: "mobile_app",     label: "Мобильное приложение" },
  { type: "website",        label: "Сайт" },
  { type: "mobile_website", label: "Мобильный сайт" },
  { type: "none",           label: "Ничего" },
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  mobile_app:     "Мобильное приложение",
  website:        "Сайт",
  mobile_website: "Мобильный сайт",
  none:           "Ничего",
};
