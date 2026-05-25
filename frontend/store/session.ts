import { create } from "zustand";
import type { Diagnosis } from "@/types/research";

export type Stage =
  | "intake" | "clarify" | "brief" | "context"
  | "hypothesis" | "method" | "sampling" | "design" | "done";

export interface Brief {
  research_question: string;
  decision: string;
  constraints: string;
  known: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  source: string;
  source_type?: "analytics" | "feedback" | "past_research" | "benchmark";
  priority: number;
  falsifiable: boolean;
  verification_methods?: string[];
  verification_method?: string;
  action_if_confirmed?: string;
}

export interface Method {
  name: string;
  method_key: string;
  uncertainty_type: string;
  rationale: string;
  // participants is no longer shown on MethodScreen — sample size is decided
  // on the Sampling step (segments × per-segment minimum). Kept optional for
  // back-compat with stored sessions and METHOD_PRESETS.
  participants?: number;
  duration: string;
  format: string;
  order?: number;
  phase?: MethodPhase;
}

export type MethodPhase = "qualitative" | "quantitative" | "concept" | "usability";

export interface PlannedMethod extends Method {
  order: number;
  phase: MethodPhase;
}

export interface MethodPlan {
  methods: PlannedMethod[];
  primary_method_key: string;
  sequence_rationale: string;
}

export interface Sample {
  segments: { name: string; description: string; size: number }[];
  total_size: number;
  criteria: { include: string[]; exclude: string[] };
  screener: string[];
}

export interface GuideBlock {
  title: string;
  duration: string;
  goal: string;
  questions: string[];
  probes?: string[];
  hypothesis_id?: string | null;
  hypothesis_ids?: string[];
}

export interface UsabilityTask {
  title: string;
  hypothesis_text: string | null;
  scenario: string;
  task: string;
  observe: string;
  followup: string[];
  success_criteria: string;
  hypothesis_ids: string[];
}

export type SurveyQuestionType =
  | "single_choice"
  | "multi_choice"
  | "likert_5"
  | "likert_7"
  | "ranking"
  | "numeric"
  | "open";

export type SurveyMeasurementType =
  | "behavior"
  | "frequency"
  | "importance"
  | "satisfaction"
  | "intention"
  | "priority"
  | "barriers"
  | "awareness"
  | "segment"
  | "screener"
  | "context";

export interface SurveyScale {
  type: "5-point" | "7-point";
  labels: Record<string, string>;
}

export interface SurveyQuestion {
  id: string;
  text: string;
  type: SurveyQuestionType;
  options?: string[];
  scale?: SurveyScale;
  qualifying_answers?: string[];
  measurement_type: SurveyMeasurementType;
  time_period?: string;
  unit?: string;
  randomize_options?: boolean;
  required: boolean;
  hypothesis_ids: string[];
}

export interface SurveyBlock {
  title: string;
  hypothesis_ids: string[];
  hypothesis_text?: string | null;
  randomize_block_order?: boolean;
  questions: SurveyQuestion[];
}

export interface SurveyScreener {
  goal: string;
  questions: SurveyQuestion[];
}

export interface SurveyWarmup {
  goal: string;
  questions: SurveyQuestion[];
}

export interface SurveyRoutingRule {
  if_question: string;
  if_answer_in: string[];
  skip_to: string;
  reason?: string;
}

export interface DesignMeta {
  goal: string;
  tasks?: string[];
  audience?: string;
  estimated_time?: string;
}

export interface DesignIntro {
  duration?: string;
  title?: string;
  items: string[];
}

export interface DesignClosing {
  duration?: string;
  title?: string;
  questions?: string[];
  items?: string[];
}

export interface Design {
  // интервью
  meta?: DesignMeta;
  intro?: DesignIntro;
  guide_blocks?: GuideBlock[];
  // юзабилити
  pre_interview?: { goal: string; questions: string[] };
  tasks?: UsabilityTask[];
  sus?: { scale: string; statements: string[] };
  closing?: DesignClosing;
  // опрос
  screener?: SurveyScreener;
  warmup?: SurveyWarmup;
  main_blocks?: SurveyBlock[];
  open_questions?: SurveyQuestion[];
  demographics?: SurveyQuestion[];
  routing?: SurveyRoutingRule[];
  total_duration?: string;
  quality_checks: Record<string, boolean>;
}

interface SessionState {
  session_id: string | null;
  owner_token: string | null;
  stage: Stage;
  brief: Brief | null;
  hypotheses: Hypothesis[];
  method: Method | null;
  methodPlan: MethodPlan | null;
  sample: Sample | null;
  design: Design | null;
  streaming: boolean;
  streamText: string;
  diagnosis: Diagnosis | null;

  setSessionId: (id: string) => void;
  setOwnerToken: (token: string | null) => void;
  setStage: (stage: Stage) => void;
  setBrief: (brief: Brief) => void;
  setHypotheses: (hs: Hypothesis[]) => void;
  setMethod: (m: Method) => void;
  setMethodPlan: (p: MethodPlan | null) => void;
  setSample: (s: Sample | null) => void;
  setDesign: (d: Design | null) => void;
  appendStreamText: (chunk: string) => void;
  clearStreamText: () => void;
  setStreaming: (v: boolean) => void;
  setDiagnosis: (d: Diagnosis | null) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  session_id: null,
  owner_token: null,
  stage: "intake",
  brief: null,
  hypotheses: [],
  method: null,
  methodPlan: null,
  sample: null,
  design: null,
  streaming: false,
  streamText: "",
  diagnosis: null,

  setSessionId: (id) => set({ session_id: id }),
  setOwnerToken: (owner_token) => set({ owner_token }),
  setStage: (stage) => set({ stage }),
  setBrief: (brief) => set({ brief }),
  setHypotheses: (hypotheses) => set({ hypotheses }),
  setMethod: (method) => set({ method }),
  setMethodPlan: (methodPlan) => set({ methodPlan }),
  setSample: (sample) => set({ sample }),
  setDesign: (design) => set({ design }),
  appendStreamText: (chunk) => set((s) => ({ streamText: s.streamText + chunk })),
  clearStreamText: () => set({ streamText: "" }),
  setStreaming: (streaming) => set({ streaming }),
  setDiagnosis: (diagnosis) => set({ diagnosis }),
}));
